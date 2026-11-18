"""Verify the frozen frontend Git tag and, optionally, the working source."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
TAG = "frontend-baseline-v1"


def git(*args):
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    result = subprocess.run(
        ["git", "--no-replace-objects", "--no-lazy-fetch", "-C", str(ROOT), *args],
        capture_output=True, env=env,
    )
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def verify(source):
    lock = json.loads((ROOT / "baselines/frontend.lock.json").read_text(encoding="utf-8"))
    if lock["tag"] != TAG:
        raise ValueError(f"Expected manifest tag {TAG}")
    expected = {}
    for entry in lock["files"]:
        path = entry["path"]
        if not re.fullmatch(r"[-A-Za-z0-9_.]+(?:/[-A-Za-z0-9_.]+)*", path):
            raise ValueError(f"Invalid manifest path: {path}")
        if any(part in {".", ".."} for part in path.split("/")) or path in expected:
            raise ValueError(f"Invalid or duplicate manifest path: {path}")
        expected[path] = entry

    ref = f"refs/tags/{TAG}"
    tag_oid = git("rev-parse", "--verify", ref).decode("ascii").strip()
    if tag_oid != lock["tag_oid"] or git("cat-file", "-t", tag_oid) != b"tag\n":
        raise ValueError(f"{TAG} does not match the pinned annotated tag object")
    commit = git("rev-parse", "--verify", f"{tag_oid}^{{commit}}").decode("ascii").strip()
    actual = {}
    for record in git("ls-tree", "-rzt", commit).split(b"\0")[:-1]:
        metadata, name = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        path = name.decode("utf-8")
        if kind == "tree" and any(p.startswith(path + "/") for p in expected):
            continue
        if (mode, kind) != ("100644", "blob"):
            raise ValueError(f"Unexpected tag entry: {path} ({mode} {kind})")
        actual[path] = oid

    if actual.keys() != expected.keys():
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        raise ValueError(f"Tag paths differ (missing={missing}, extra={extra})")

    for path, entry in expected.items():
        blob = git("cat-file", "blob", actual[path])
        if len(blob) != entry["size"] or hashlib.sha256(blob).hexdigest() != entry["sha256"]:
            raise ValueError(f"Tag size or SHA-256 differs: {path}")
        if source is not None:
            candidate = (source / path).resolve(strict=True)
            if not candidate.is_relative_to(source) or not candidate.is_file():
                raise ValueError(f"Source path is not a regular file within the source root: {path}")
            if candidate.read_bytes() != blob:
                raise ValueError(f"Source bytes differ from the verified tag and manifest: {path}")
    return len(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="also verify the named files in this frontend directory")
    args = parser.parse_args()
    try:
        source = args.source.resolve(strict=True) if args.source is not None else None
        count = verify(source)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"Frontend baseline verification failed: {exc}\n")
    print(f"Verified {count} files in {TAG}" + (f" and {source}" if source is not None else ""))


if __name__ == "__main__":
    main()
