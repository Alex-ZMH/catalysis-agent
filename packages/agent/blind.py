"""Freeze a reference-free workbench run and verify its saved predictions after disclosure."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from jsonschema import ValidationError

from packages.agent.workspace import Workspace, digest, json_bytes
from packages.check import link_result
from packages.science import field_probe, lammps


def _sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Expected a lowercase SHA-256 digest")
    return value


def _snapshot(store, run_id, ref_sha):
    _sha(ref_sha)
    manifest = store.manifest(run_id)
    run = store.detail(run_id)
    kind = run["kind"]
    if (kind not in ("md", "equipment") or run["reference_id"] is not None
            or manifest["inputs"] != [run["raw_id"]]):
        raise ValueError("Freeze requires a reference-free MD or equipment import")
    if (manifest["project_id"] != store.project or manifest["run_id"] != run_id
            or run["id"] != run_id or run["quality"] != "accepted"):
        raise ValueError("Run identity or quality does not match the project")
    artifacts = {a["id"]: a for a in run["artifacts"]}
    raw = artifacts[run["raw_id"]]
    filename, raw_bytes = store.download(run_id, raw["id"])
    if (raw["role"] != "source" or filename != run["filename"]
            or digest(raw_bytes) == ref_sha):
        raise ValueError("Expected the original raw upload and a distinct reference")
    del raw_bytes
    config = run["input"]
    params = artifacts[manifest["parameters_artifact"]]
    if (digest(json_bytes(config)) != params["sha256"] or config.get("kind") != kind
            or config.get("origin") != run["origin"] or "reference" in config):
        raise ValueError("Parameters do not match the reference-free import")
    result = run["result"]
    if kind == "md":
        if run["details"].get("reference_verified") or "reference_artifact_id" in run["details"]:
            raise ValueError("Trajectory already contains a reference comparison")
    else:
        specs = config["options"].get("profiles")
        if not specs or len(specs) != len(result.get("line_profiles", [])):
            raise ValueError("Freeze requires predeclared equipment line profiles")
        if any(set(spec) - {"a", "b", "field", "fractions", "count"} for spec in specs):
            raise ValueError("Freeze accepts only sampling specifications in equipment profiles")
        if any("reference" in p for p in result["line_profiles"]):
            raise ValueError("Equipment result already contains a reference comparison")
    output_records = {artifacts[i]["name"]: artifacts[i] for i in manifest["outputs"]}
    result_bytes = json_bytes(result)
    if (set(output_records) != {"result.json", "details.json"}
            or digest(result_bytes) != output_records["result.json"]["sha256"]
            or digest(json_bytes(run["details"])) != output_records["details.json"]["sha256"]):
        raise ValueError("Frozen outputs differ from the manifest")
    link_result(kind, result, result_bytes, manifest)
    receipt = dict(
        format="a5-blind-v1", project=store.project, kind=kind, run_id=run_id,
        code_commit=manifest["code_commit"], origin=run["origin"], filename=filename,
        run_recorded_at=manifest["recorded_at"], raw_sha256=raw["sha256"],
        parameters_sha256=params["sha256"], result_sha256=output_records["result.json"]["sha256"],
        details_sha256=output_records["details.json"]["sha256"],
        manifest_sha256=digest(json_bytes(manifest)), reference_sha256=ref_sha,
    )
    if kind == "md":
        receipt["max_reference_bytes"] = config["options"].get(
            "max_reference_bytes", lammps.DEFAULT_REFERENCE_BYTES)
    return receipt, run


def freeze(store, run_id, reference_sha256):
    """Seal the recorded workbench outputs using only the reference owner's digest."""
    return _snapshot(store, run_id, reference_sha256)[0]


def reveal(store, receipt, reference_name, reference_bytes):
    """Compare the content-verified prediction itself. No new workbench analysis is created."""
    if not isinstance(receipt, dict) or receipt.get("format") != "a5-blind-v1":
        raise ValueError("Unknown blind receipt format")
    expected = _sha(receipt.get("reference_sha256"))
    if digest(reference_bytes) != expected:
        raise ValueError("Reference bytes differ from the SHA-256 committed before disclosure")
    current, run = _snapshot(store, receipt["run_id"], expected)
    if current != receipt:
        raise ValueError("Run evidence differs from the frozen receipt")
    ref = (reference_name, reference_bytes, "ref-" + expected)
    if run["kind"] == "md":
        comparisons = lammps.compare_frozen(run["result"], run["details"], ref,
                                            max_reference_bytes=receipt["max_reference_bytes"])
    else:
        comparisons = field_probe.compare_frozen(run["result"], run["details"], ref)
    return dict(status="passed", project=store.project, kind=run["kind"], run_id=run["id"],
                code_commit=receipt["code_commit"], verifier_commit=store.commit,
                origin=run["origin"], result_sha256=receipt["result_sha256"],
                reference_name=reference_name, reference_sha256=expected, comparison=comparisons)


def _publish(path, content):
    path = path.resolve()
    if any((p / ".git").exists() for p in path.parents):
        raise ValueError("Choose an evidence directory outside Git")
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            tmp.unlink(missing_ok=True)
            raise
    try:
        try:
            os.link(tmp, path)
        except FileExistsError:
            if path.read_bytes() != content:
                raise ValueError(f"Evidence already exists with different contents: {path}") from None
    finally:
        tmp.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    params = sub.add_parser("freeze")
    check = sub.add_parser("reveal")
    for p in (params, check):
        p.add_argument("--data-dir", type=Path, required=True)
        p.add_argument("--project", required=True)
        p.add_argument("--receipt", type=Path, required=True)
    params.add_argument("--run-id", required=True)
    params.add_argument("--reference-sha256", required=True)
    check.add_argument("--receipt-sha256", required=True)
    check.add_argument("--reference", type=Path, required=True)
    check.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if not (args.data_dir / "projects" / args.project / "runs").is_dir():
            raise ValueError("Existing workbench project required")
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"],
                                         cwd=Path(__file__).resolve().parents[2], text=True).strip()
        store = Workspace(args.data_dir, args.project, "blind-review", commit)
        if args.action == "freeze":
            receipt = json_bytes(freeze(store, args.run_id, args.reference_sha256)) + b"\n"
            _publish(args.receipt, receipt)
            print(digest(receipt))
            return 0
        receipt_bytes = args.receipt.read_bytes()
        if digest(receipt_bytes) != _sha(args.receipt_sha256):
            raise ValueError("Receipt differs from the independently retained SHA-256")
        receipt = json.loads(receipt_bytes)
        limit = receipt.get("max_reference_bytes") if isinstance(receipt, dict) else None
        with args.reference.open("rb") as stream:
            if limit is None:
                reference = stream.read()
            elif type(limit) is int and limit > 0:
                if os.fstat(stream.fileno()).st_size > limit:
                    raise ValueError("Reference exceeds the frozen trajectory import's size limit")
                reference = stream.read()
            else:
                raise ValueError("Invalid reference size limit in receipt")
        try:
            report = reveal(store, receipt, args.reference.name, reference)
        except (ValueError, KeyError, ValidationError) as exc:
            report = dict(status="failed", project=store.project, verifier_commit=commit,
                          run_id=receipt.get("run_id") if isinstance(receipt, dict) else None,
                          reference_name=args.reference.name, reference_sha256=digest(reference),
                          reason=str(exc))
        report["receipt_sha256"] = args.receipt_sha256
        _publish(args.report, json_bytes(report) + b"\n")
        if report["status"] == "failed":
            print(report["reason"], file=sys.stderr)
            return 1
        print(args.report)
        return 0
    except (ValueError, KeyError, OSError, ValidationError, subprocess.CalledProcessError) as exc:
        print(f"Blind review: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
