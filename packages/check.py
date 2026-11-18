"""Validate local JSON documents and optionally join a scientific result to its run."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from jsonschema import ValidationError
from packages.agent.records import validate_run
from packages.contracts import validate_schema
from packages.science import adsorption, kinetics, imports

OPERATIONS = {"adsorption": "adsorption.compare", "kinetics": "kinetics.fit",
              "md": "md.import", "equipment": "equipment.import"}


def read_document(path):
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique_keys), raw


def artifact_links(value):
    """Find domain-declared artifact links in an already validated v1 document."""
    pointers = {"raw_artifact_id", "structure_id", "bulk_structure_id", "clean_structure_id",
                "bulk_to_slab_atom_map_id", "clean_to_adsorbed_atom_map_id",
                "fixed_layers_id", "evidence_id", "reference_artifact_id"}
    if isinstance(value, dict):
        for key, item in value.items():
            if key in pointers and isinstance(item, str):
                yield item
            elif key == "reference_coefficients" and isinstance(item, dict):
                yield from item
            else:
                yield from artifact_links(item)
    elif isinstance(value, list):
        for item in value:
            yield from artifact_links(item)


def link_result(kind, result, raw_result, run, source=None, raw_source=None):
    validate_run(run)
    if OPERATIONS[kind] != run["operation"]:
        raise ValueError("Scientific operation differs from the run")
    artifacts = {item["artifact_id"]: item for item in run["artifacts"]}

    def matching_ids(ids, data):
        digest = hashlib.sha256(data).hexdigest()
        return [key for key in ids if artifacts[key]["size_bytes"] == len(data)
                and artifacts[key]["sha256"] == digest]

    outputs = matching_ids(run["outputs"], raw_result)
    if len(outputs) != 1:
        raise ValueError("Expected exactly one output matching these bytes")
    output = artifacts[outputs[0]]
    parents = set(output["parents"])
    if raw_source is not None and not matching_ids(parents.intersection(run["inputs"]), raw_source):
        raise ValueError("Normalized input bytes do not match a direct run input")
    ancestors = set()
    pending = list(parents)
    while pending:
        item = pending.pop()
        if item not in ancestors:
            ancestors.add(item)
            pending.extend(artifacts[item]["parents"])
    links = set(artifact_links(result)) | set(artifact_links(source))
    if not links <= ancestors - {run["parameters_artifact"]}:
        raise ValueError("Scientific evidence is missing from the output lineage")
    if kind == "kinetics":
        origin = {"experimental": "research", "synthetic": "synthetic"}[source["source"]]
        if origin != output["origin"] or any(artifacts[key]["origin"] != origin for key in links):
            raise ValueError("Kinetic observation origin differs from the manifest")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["run", "profile", "adsorption-input", "adsorption",
                                         "kinetics-input", "kinetics", "md", "equipment"])
    parser.add_argument("document", type=Path)
    parser.add_argument("--input", type=Path, help="normalized analysis input for a candidate result")
    parser.add_argument("--run", type=Path, help="also verify result bytes and lineage against this manifest")
    args = parser.parse_args(argv)
    kind = args.kind
    if (kind in {"adsorption", "kinetics"}) != bool(args.input):
        parser.error("--input is required only for adsorption or kinetics results")
    if args.run and kind not in OPERATIONS:
        parser.error("--run applies only to scientific results or imports")
    try:
        document, raw = read_document(args.document)
        source, raw_source = read_document(args.input) if args.input else (None, None)
        if kind == "profile":
            validate_schema("profile.schema.json", document)
        elif kind == "run":
            validate_run(document)
        elif kind in {"md", "equipment"}:
            (imports.validate_md if kind == "md" else imports.validate_equipment)(document)
        else:
            module = adsorption if kind.startswith("adsorption") else kinetics
            if kind.endswith("-input"):
                module.validate_input(document)
            else:
                module.validate_result(document, source)
        if args.run:
            run, _ = read_document(args.run)
            link_result(kind, document, raw, run, source, raw_source)
    except ValidationError as error:
        # Schema errors can include an entire row in the message. Show the path and rule.
        print(f"Invalid {kind} at {error.json_path} ({error.validator or 'domain check'})", file=sys.stderr)
        return 1
    except (OSError, ValueError, OverflowError) as error:
        print(f"Invalid {kind}: {error}", file=sys.stderr)
        return 1
    print(f"Valid {kind}" + (" with matching run lineage" if args.run else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
