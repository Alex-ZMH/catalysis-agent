"""Recompute completed Workspace runs and compare their persisted artifacts."""
import hashlib
import json
from pathlib import Path
import re

from jsonschema import ValidationError

from packages.agent.records import validate_run
from packages.agent.workspace import Workspace
from packages.check import OPERATIONS, read_document


def _without_links(path):
    for part in (*reversed(path.parents), path):
        if part.is_symlink():
            raise ValueError(f"Symbolic link in replay path: {part}")
    return path


def _run_artifacts(base, project, run_id, manifest, kind):
    validate_run(manifest)
    if (manifest["run_id"], manifest["project_id"], manifest["method"]["id"]) != (run_id, project, kind):
        raise ValueError("Manifest identity does not match the run")
    index, _ = read_document(_without_links(base / "runs" / run_id / "index.json"))
    records = {artifact["artifact_id"]: artifact for artifact in manifest["artifacts"]}
    parameters = manifest["parameters_artifact"]
    result, details = index["result"], index["details"]
    if result == details or not {result, details} <= set(manifest["outputs"]):
        raise ValueError("Result or details index differs from manifest outputs")
    slots = {"raw": index["raw"], "parameters": parameters, "result": result, "details": details}
    if "reference_id" in index:
        slots["reference"] = index["reference_id"]
    sources = {slots[name] for name in ("raw", "reference") if name in slots}
    if len(sources) != 1 + ("reference" in slots) or any(records[key]["role"] != "source" for key in sources):
        raise ValueError("Invalid source artifact index")
    if kind in {"adsorption", "kinetics"}:
        if "reference" in slots or manifest["inputs"] != [index["input"]] or records[index["input"]]["role"] != "derived":
            raise ValueError("Invalid normalized input index")
        slots["normalized"] = index["input"]
    elif index["input"] != parameters or set(manifest["inputs"]) != sources:
        raise ValueError("Invalid raw import input index")
    names = index["names"]
    remaining = records.keys() - slots.values()
    for key in sorted(remaining):
        slot = f"artifact:{records[key]['role']}:{names[key]}"
        if slot in slots:
            raise ValueError(f"Ambiguous artifact name: {slot}")
        slots[slot] = key
    return {slot: records[key] for slot, key in slots.items()}, names


def _check_bytes(base, record, retain=False):
    expected = record["sha256"]
    check = {"expected_sha256": expected, "actual_sha256": None, "verified": False}
    try:
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError("Invalid SHA-256 in manifest")
        path = _without_links(base / "raw" / expected[:2] / expected)
        if not path.is_file():
            raise ValueError(f"Artifact is missing or is not a regular file: {expected}")
        sha256 = hashlib.sha256()
        size = 0
        raw = bytearray() if retain else None
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                sha256.update(chunk)
                size += len(chunk)
                if retain:
                    raw.extend(chunk)
        check["actual_sha256"] = sha256.hexdigest()
        if check["actual_sha256"] != expected or size != record["size_bytes"]:
            raise ValueError("Artifact size or SHA-256 differs from manifest")
    except (OSError, ValueError) as error:
        check["error"] = str(error)
        return check, None
    check["verified"] = True
    return check, bytes(raw) if retain else None


def _replay_run(source, run_dir, workspace, report):
    run_id = run_dir.name
    manifest, _ = read_document(_without_links(run_dir / "manifest.json"))
    report["original_code_commit"] = manifest["code_commit"]
    kind = next((key for key, operation in OPERATIONS.items() if operation == manifest["operation"]), None)
    if kind is None:
        report["status"] = "skipped"
        report["error"] = "Unsupported scientific operation"
        return
    report["kind"] = kind
    records, names = _run_artifacts(source, workspace.project, run_id, manifest, kind)
    checks = report["artifacts"]
    inputs = {}
    for slot, record in records.items():
        required_input = slot in {"raw", "parameters", "reference"}
        check, raw = _check_bytes(source, record, retain=required_input)
        checks[slot] = {"original": check, "replayed": None, "match": None if check["verified"] else False}
        if required_input:
            inputs[slot] = raw
    if any(raw is None for raw in inputs.values()):
        report["status"] = "mismatch"
        report["error"] = "Required original input failed verification"
        return

    config = json.loads(inputs["parameters"])
    origin = records["raw"]["origin"]
    if config["kind"] != kind or config["origin"] != origin:
        raise ValueError("Original parameters differ from run kind or source origin")
    reference = None
    if "reference" in inputs:
        artifact = records["reference"]
        ref_name = names[artifact["artifact_id"]]
        if config.get("reference") != {"filename": ref_name, "sha256": artifact["sha256"]}:
            raise ValueError("Reference differs from original parameters")
        reference = (ref_name, inputs["reference"])
    elif "reference" in config:
        raise ValueError("Original parameters declare a missing reference")

    replayed = workspace.analyze(kind, names[records["raw"]["artifact_id"]],
                                 inputs["raw"], config["options"], origin, reference)
    replay_id = replayed["id"]
    report["replayed_run_id"] = replay_id
    replay_manifest = workspace.manifest(replay_id)
    report["replayed_code_commit"] = replay_manifest["code_commit"]
    target = workspace.runs.parent
    replay_records, _ = _run_artifacts(target, workspace.project, replay_id, replay_manifest, kind)
    for slot in sorted(checks.keys() | replay_records.keys()):
        comparison = checks.setdefault(slot, {"original": None, "replayed": None, "match": None})
        if slot in replay_records:
            comparison["replayed"], _ = _check_bytes(target, replay_records[slot])
        original, replay = comparison["original"], comparison["replayed"]
        comparison["match"] = bool(original and replay and original["verified"] and replay["verified"]
                                   and original["actual_sha256"] == replay["actual_sha256"])
    report["status"] = "matched" if all(check["match"] for check in checks.values()) else "mismatch"


def replay_project(data_dir, project, destination, code_commit):
    """Replay supported completed runs into an empty, separate data directory.

    Reports are keyed by logical artifact roles and retain one row per original run.
    Comparisons use byte hashes, independently of run IDs and code commits.
    """
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}", project):
        raise ValueError("Invalid project ID")
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", code_commit):
        raise ValueError("Expected a full lowercase Git commit SHA")
    source_root = _without_links(Path(data_dir).absolute()).resolve()
    source = _without_links(source_root / "projects" / project)
    if not source.is_dir():
        raise FileNotFoundError("Source project directory does not exist")
    runs = _without_links(source / "runs")
    _without_links(source / "raw")
    destination = _without_links(Path(destination).absolute()).resolve()
    if destination.is_relative_to(source_root) or source_root.is_relative_to(destination):
        raise ValueError("Replay destination must be separate from the source data directory")
    if any((path / ".git").exists() for path in (destination, *destination.parents)):
        raise ValueError("Select a data directory outside all Git worktrees")
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("Replay destination must be empty")
    (destination / "projects").mkdir()
    workspace = Workspace(destination, project, "replay", code_commit)
    report = {"ok": True, "project": project, "destination": str(destination),
              "code_commit": code_commit, "runs": []}
    run_dirs = sorted(runs.iterdir()) if runs.exists() else []
    for run_dir in run_dirs:
        if not re.fullmatch(r"run-[0-9a-f]{64}", run_dir.name):
            continue
        row = {"original_run_id": run_dir.name, "original_code_commit": None,
               "replayed_run_id": None, "replayed_code_commit": None, "artifacts": {}}
        try:
            _replay_run(source, run_dir, workspace, row)
        except ValidationError as error:
            row.update(status="error", error=f"Invalid record at {error.json_path} ({error.validator})")
        except (OSError, ValueError, KeyError, TypeError, OverflowError) as error:
            row.update(status="error", error=str(error))
        report["runs"].append(row)
    if not report["runs"]:
        report["reason"] = "no_runs"
    report["ok"] = bool(report["runs"]) and all(row["status"] == "matched" for row in report["runs"])
    report["status"] = "matched" if report["ok"] else "failed"
    return report
