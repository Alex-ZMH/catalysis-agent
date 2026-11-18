"""Behavioral tests for committed, offline blind reference review."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from jsonschema import ValidationError

from packages.agent import blind
from packages.agent.workspace import Workspace

try:
    from tests.test_a5_workbench import CASES
except ModuleNotFoundError:
    from test_a5_workbench import CASES


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class BlindReviewTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.data_dir = Path(directory.name)
        self.store = Workspace(self.data_dir, "fixture", "Astra", "1" * 40)

    def raw_case(self, kind, options=None, store=None):
        store = self.store if store is None else store
        filename, content, defaults, expected = CASES[kind]()
        options = copy.deepcopy(defaults if options is None else options)
        oracle = copy.deepcopy(expected)
        run = store.analyze(kind, filename, content, options, "synthetic", None)
        return run, json_bytes(oracle), oracle

    def equipment_profiles(self, oracle):
        return [
            {key: copy.deepcopy(profile[key])
             for key in ("a", "b", "field", "fractions")}
            for profile in oracle["profiles"]
        ]

    def assert_passed(self, report, run):
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["run_id"], run["id"])
        self.assertIn("comparison", report)

    def reveal_without_recompute(self, store, receipt, reference_name, reference):
        before = store.recent()
        with patch.object(
            Workspace, "analyze", side_effect=AssertionError("reveal must not create a run")
        ) as analyze, patch(
            "packages.science.lammps.read_import",
            side_effect=AssertionError("reveal must not reparse a dump"),
        ) as lammps_import, patch(
            "packages.science.field_probe.read_import",
            side_effect=AssertionError("reveal must not resample a mesh"),
        ) as field_import, patch(
            "packages.science.vtu_reader.read_mesh",
            side_effect=AssertionError("reveal must not reread a mesh"),
        ) as mesh_read:
            report = blind.reveal(store, receipt, reference_name, reference)
        self.assertEqual(analyze.call_count, 0)
        self.assertEqual(lammps_import.call_count, 0)
        self.assertEqual(field_import.call_count, 0)
        self.assertEqual(mesh_read.call_count, 0)
        self.assertEqual(store.recent(), before)
        return report

    def artifact_path(self, store, run_id, artifact_id):
        manifest = store.manifest(run_id)
        record = next(item for item in manifest["artifacts"]
                      if item["artifact_id"] == artifact_id)
        return store.blobs / record["sha256"][:2] / record["sha256"]

    def test_freeze_rejects_run_with_uploaded_reference(self):
        filename, content, options, oracle = CASES["md"]()
        reference = json_bytes(copy.deepcopy(oracle))
        run = self.store.analyze(
            "md", filename, content, copy.deepcopy(options), "synthetic",
            ("reference.json", reference),
        )
        self.assertIsNotNone(run["reference_id"])
        with self.assertRaises((ValueError, ValidationError)):
            blind.freeze(self.store, run["id"], sha256(reference))

    def test_freeze_rejects_equipment_without_preset_profiles(self):
        run, oracle, _ = self.raw_case("equipment")
        self.assertIsNone(run["reference_id"])
        with self.assertRaises((ValueError, ValidationError)):
            blind.freeze(self.store, run["id"], sha256(oracle))

    def test_reveal_rejects_partial_reference_for_two_frozen_profiles(self):
        filename, content, defaults, expected = CASES["equipment"]()
        options = copy.deepcopy(defaults)
        options["profiles"] = self.equipment_profiles(expected)
        run = self.store.analyze("equipment", filename, content, options, "synthetic", None)
        self.assertIsNone(run["reference_id"])
        partial = copy.deepcopy(expected)
        partial["profiles"] = partial["profiles"][:1]
        partial_reference = json_bytes(partial)

        receipt = blind.freeze(self.store, run["id"], sha256(partial_reference))
        with self.assertRaises((ValueError, ValidationError)):
            blind.reveal(self.store, receipt, "partial-reference.json", partial_reference)

    def test_frozen_md_passes_without_reparse_or_new_workbench_run(self):
        run, oracle, _ = self.raw_case("md")
        receipt = blind.freeze(self.store, run["id"], sha256(oracle))

        report = self.reveal_without_recompute(
            self.store, receipt, "oracle.json", oracle
        )
        self.assert_passed(report, run)

    def test_frozen_vtu_passes_with_two_oracle_driven_profiles(self):
        _, _, defaults, expected = CASES["equipment"]()
        options = copy.deepcopy(defaults)
        options["profiles"] = self.equipment_profiles(expected)
        self.assertEqual(
            {key for profile in options["profiles"] for key in profile},
            {"a", "b", "field", "fractions"},
        )
        run, oracle, _ = self.raw_case("equipment", options=options)
        self.assertIsNone(run["reference_id"])
        receipt = blind.freeze(self.store, run["id"], sha256(oracle))

        report = self.reveal_without_recompute(
            self.store, receipt, "oracle.json", oracle
        )
        self.assert_passed(report, run)

    def test_reveal_rejects_changed_reference_hash(self):
        run, oracle, _ = self.raw_case("md")
        receipt = blind.freeze(self.store, run["id"], sha256(oracle))
        changed = oracle + bytes([10])

        with self.assertRaises((ValueError, ValidationError)):
            blind.reveal(self.store, receipt, "oracle.json", changed)

    def test_reveal_rejects_promised_but_numerically_wrong_reference(self):
        run, _, expected = self.raw_case("md")
        wrong = copy.deepcopy(expected)
        wrong["frames"][0]["atoms"][0]["position"][0] += 1
        wrong = json_bytes(wrong)
        receipt = blind.freeze(self.store, run["id"], sha256(wrong))
        self.assertEqual(receipt["reference_sha256"], sha256(wrong))

        with self.assertRaises((ValueError, ValidationError)):
            blind.reveal(self.store, receipt, "wrong.json", wrong)

    def test_reveal_rejects_corrupt_frozen_source_or_result(self):
        for artifact_name in ("source", "result.json"):
            with self.subTest(artifact=artifact_name):
                directory = tempfile.TemporaryDirectory()
                self.addCleanup(directory.cleanup)
                store = Workspace(Path(directory.name), "fixture", "Astra", "1" * 40)
                run, oracle, _ = self.raw_case("md", store=store)
                receipt = blind.freeze(store, run["id"], sha256(oracle))
                artifact_id = (
                    run["raw_id"] if artifact_name == "source"
                    else next(item["id"] for item in run["artifacts"]
                              if item["name"] == "result.json")
                )
                path = self.artifact_path(store, run["id"], artifact_id)
                path.write_bytes(path.read_bytes() + b"corruption")

                with self.assertRaises((ValueError, ValidationError)):
                    blind.reveal(store, receipt, "oracle.json", oracle)

    def cli_reveal(self, receipt_path, receipt_digest, reference_path, report_path):
        return subprocess.run(
            [
                sys.executable, "-m", "packages.agent.blind", "reveal",
                "--data-dir", str(self.data_dir),
                "--project", "fixture",
                "--receipt", str(receipt_path),
                "--receipt-sha256", receipt_digest,
                "--reference", str(reference_path),
                "--report", str(report_path),
            ],
            cwd=Path(__file__).resolve().parents[1],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )

    def test_cli_reveal_passes_and_failed_replacement_cannot_pass(self):
        run, oracle, _ = self.raw_case("md")
        receipt = blind.freeze(self.store, run["id"], sha256(oracle))
        receipt_content = json_bytes(receipt)

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            receipt_path = directory / "receipt.json"
            reference_path = directory / "oracle.json"
            report_path = directory / "report.json"
            receipt_path.write_bytes(receipt_content)
            reference_path.write_bytes(oracle)

            success = self.cli_reveal(
                receipt_path, sha256(receipt_content), reference_path, report_path
            )
            self.assertEqual(success.returncode, 0, success.stderr)
            self.assert_passed(json.loads(report_path.read_bytes()), run)

            replacement_path = directory / "replacement.json"
            replacement_report = directory / "replacement-report.json"
            replacement_path.write_bytes(oracle + bytes([10]))
            failure = self.cli_reveal(
                receipt_path, sha256(receipt_content), replacement_path, replacement_report
            )
            self.assertNotEqual(failure.returncode, 0, failure.stdout + failure.stderr)
            if replacement_report.exists():
                self.assertNotEqual(
                    json.loads(replacement_report.read_bytes()).get("status"), "passed"
                )


if __name__ == "__main__":
    unittest.main()
