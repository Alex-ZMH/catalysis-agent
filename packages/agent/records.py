"""Cross-record checks for a self-contained run manifest, with optional blob verification."""
from datetime import datetime
import hashlib
from graphlib import CycleError, TopologicalSorter

from packages.contracts import validate_schema


def validate_run(record):
    validate_schema("run.schema.json", record)
    datetime.fromisoformat(record["recorded_at"])
    artifacts = {item["artifact_id"]: item for item in record["artifacts"]}
    if len(artifacts) != len(record["artifacts"]):
        raise ValueError("Duplicate artifact ID")
    inputs, outputs = set(record["inputs"]), set(record["outputs"])
    config = record["parameters_artifact"]
    if inputs & outputs or config in inputs | outputs:
        raise ValueError("Parameters, inputs and outputs must have distinct IDs")
    if not (inputs | outputs | {config}) <= artifacts.keys():
        raise ValueError("Unresolved run artifact reference")
    if artifacts[config]["role"] != "parameters":
        raise ValueError("Expected a parameters artifact")
    if record["quality"] != "accepted" and not record["quality_flags"]:
        raise ValueError("Record the reason for review or blocking")
    execution = record.get("execution")
    if execution is not None:
        source_ids = [item["artifact_id"] for item in execution["sources"]]
        if len(source_ids) != len(set(source_ids)) or not set(source_ids) <= inputs:
            raise ValueError("Execution sources must be declared raw run inputs")
        for source in execution["sources"]:
            artifact = artifacts[source["artifact_id"]]
            if artifact["role"] != "source" or any(char in source["name"] for char in "/\\"):
                raise ValueError("Execution source must name a project-local raw artifact")

    graph = {}
    for name, artifact in artifacts.items():
        if artifact["project_id"] != record["project_id"]:
            raise ValueError("Artifact belongs to a different project")
        parents = set(artifact["parents"])
        if not parents <= artifacts.keys():
            raise ValueError("Missing artifact ancestor")
        if bool(parents) != (artifact["role"] == "derived"):
            raise ValueError("Only derived artifacts carry parent links")
        graph[name] = parents
    try:
        order = list(TopologicalSorter(graph).static_order())
    except CycleError as error:
        raise ValueError("Artifact lineage contains a cycle") from error

    used = set(outputs)
    for name in reversed(order):
        if name in used:
            used.update(graph[name])
        if artifacts[name]["origin"] == "research" and any(
            artifacts[parent]["origin"] == "synthetic" for parent in graph[name]
            if artifacts[parent]["role"] != "parameters"
        ):
            raise ValueError("A synthetic observation cannot become a research result")
    if used != artifacts.keys():
        raise ValueError("Manifest contains artifacts unrelated to the outputs")
    for name in outputs:
        if artifacts[name]["role"] != "derived" or config not in graph[name]:
            raise ValueError("Output must refer to the exact parameters used")
        if not graph[name] <= inputs | outputs | {config}:
            raise ValueError("Output references an undeclared direct input")
        if not graph[name] & inputs:
            raise ValueError("Output must reference a declared run input")
    if not inputs <= set.union(*(graph[name] for name in outputs)):
        raise ValueError("Declared input missing from output lineage")


def verify_blob(artifact, stream):
    """Stream from an already authorized project-local store; retain no file names."""
    digest = hashlib.sha256()
    total = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
        total += len(chunk)
    if total != artifact["size_bytes"] or digest.hexdigest() != artifact["sha256"]:
        raise ValueError("Artifact size or SHA-256 mismatch")
