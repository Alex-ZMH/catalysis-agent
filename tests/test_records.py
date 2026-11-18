import copy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import unittest

from jsonschema import ValidationError

from packages.agent.records import validate_run, verify_blob
from packages.contracts import validate_schema

ROOT = Path(__file__).resolve().parents[1]


def example_run():
    def artifact(name, role, content, parents=()):
        return dict(artifact_id=name, project_id="project-synthetic",
                    sha256=hashlib.sha256(content).hexdigest(), size_bytes=len(content),
                    format="json", origin="synthetic", role=role, parents=list(parents))

    return dict(schema_version="1.0.0", project_id="project-synthetic",
                run_id="run-01", operator_id="fixture-author", recorded_at="2026-01-01T00:00:00Z",
                operation="md.import", method={"id": "trajectory-import", "version": "0.1.0"},
                code_commit="1" * 40, profile="intranet-v1", parameters_artifact="cfg",
                inputs=["raw"], outputs=["normalized"], quality="accepted", quality_flags=[],
                artifacts=[artifact("cfg", "parameters", b"{}"), artifact("raw", "source", b"123"),
                           artifact("normalized", "derived", b"[1]", ["cfg", "raw"])])


class RunAcceptance(unittest.TestCase):
    def test_external_location_and_other_project(self):
        for key, value in [("artifact_id", "https://invalid.local/result"), ("artifact_id", "../raw"),
                           ("artifact_id", "raw\n"), ("project_id", "other")]:
            with self.subTest(key=key, value=value):
                run = example_run()
                run["artifacts"][1][key] = value
                with self.assertRaises((ValueError, ValidationError)):
                    validate_run(run)

    def test_length_and_digest_are_independent(self):
        run = example_run()
        validate_run(run)
        raw = run["artifacts"][1]
        verify_blob(raw, BytesIO(b"123"))
        for damaged in [b"124", b"12"]:
            with self.assertRaises(ValueError):
                verify_blob(raw, BytesIO(damaged))

    def test_reject_inconsistent_lineage(self):
        run = example_run()
        changes = [
            lambda r: r["artifacts"].append(copy.deepcopy(r["artifacts"][0])),
            lambda r: r["artifacts"][2]["parents"].append("missing"),
            lambda r: r["artifacts"][2]["parents"].append("normalized"),
            lambda r: r["artifacts"][2]["parents"].remove("cfg"),
            lambda r: r["artifacts"][2].update(origin="research"),
            lambda r: r["artifacts"].append(dict(r["artifacts"][1], artifact_id="unused")),
            lambda r: r.update(recorded_at="2026-02-31T00:00:00Z"),
            lambda r: r.update(quality="blocked"),
        ]
        for change in changes:
            current = copy.deepcopy(run)
            change(current)
            with self.assertRaises((ValueError, ValidationError)):
                validate_run(current)

    def test_profile_and_inventory(self):
        profile = json.loads((ROOT / "configs/profiles/intranet.json").read_text(encoding="utf-8"))
        validate_schema("profile.schema.json", profile)
        self.assertEqual(len(profile["inventory"]), 4)
        for edit in ({"external_egress": True}, {"cluster_submission": True},
                     {"heavy_compute": "approved_submit"}, {"remote_endpoint": "example"}):
            with self.subTest(edit=edit), self.assertRaises(ValidationError):
                validate_schema("profile.schema.json", profile | edit)
        for operation in ["cluster.submit", "shell.exec", "md.solve", "equipment.solve"]:
            with self.subTest(operation=operation), self.assertRaises(ValidationError):
                validate_run(example_run() | {"operation": operation})
