"""Offline recovery coverage against native Workspace fixtures."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from packages.agent.replay import replay_project
from packages.agent.workspace import Workspace, digest, json_bytes
from test_a5_workbench import equipment_case, md_case
from test_vasp_import import demo as vasp_case


class ProjectReplay(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "restored"
        self.destination = self.root / "replayed"
        self.store = Workspace(self.source, "project", "original", "1" * 40)
        self.project = self.store.runs.parent

    def add_kinetics(self, name="rates.csv"):
        data = (b"temperature_K,value,batch_id,relative_uncertainty\n"
                b"300,0.1,B,0.02\n320,0.2,B,0.02\n340,0.4,B,0.02\n360,0.8,B,0.02\n")
        return self.store.analyze("kinetics", name, data, {}, "synthetic")

    def replay(self):
        report = replay_project(self.source, "project", self.destination, "2" * 40)
        self.assertEqual(json.loads(json.dumps(report)), report)
        return report

    def snapshot(self):
        return {path.relative_to(self.project): path.read_bytes()
                for path in self.project.rglob("*") if path.is_file()}

    def test_supported_runs_with_references_and_distinct_logical_names(self):
        originals = [self.add_kinetics(), self.add_kinetics("converted rates.csv"),
                     self.store.analyze("adsorption", *vasp_case(), "synthetic")]
        for kind, fixture, origin in (("md", md_case, "synthetic"), ("equipment", equipment_case, "research")):
            name, raw, options, reference = fixture()
            originals.append(self.store.analyze(kind, name, raw, options, origin,
                                                (f"{kind} reference.json", json.dumps(reference).encode())))
        approvals = self.project / "approvals"
        approvals.mkdir()
        (approvals / "approvals.sqlite3").write_bytes(b"approval canary")
        before = self.snapshot()
        report = self.replay()
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["status"], "matched")
        self.assertEqual(self.snapshot(), before)
        replay = Workspace(self.destination, "project", "replay", "2" * 40)
        self.assertFalse((replay.runs.parent / "approvals").exists())
        self.assertEqual(len(replay.recent()), len(originals))
        by_id = {run["id"]: run for run in originals}
        for row in report["runs"]:
            original = by_id.pop(row["original_run_id"])
            self.assertNotEqual(row["original_run_id"], row["replayed_run_id"])
            self.assertEqual(row["original_code_commit"], "1" * 40)
            self.assertEqual(row["replayed_code_commit"], "2" * 40)
            self.assertEqual(replay.detail(row["replayed_run_id"])["filename"], original["filename"])
            extra = "reference" if original["reference_id"] else "normalized"
            self.assertEqual({slot for slot in row["artifacts"] if not slot.startswith("artifact:")},
                             {"raw", "parameters", "result", "details", extra})
            for item in row["artifacts"].values():
                self.assertTrue(item["match"])
                for phase in ("original", "replayed"):
                    self.assertEqual(item[phase]["expected_sha256"], item[phase]["actual_sha256"])
        self.assertFalse(by_id)

    def test_identical_inputs_from_two_original_commits_each_get_a_report(self):
        first = self.add_kinetics()
        raw = self.store.download(first["id"], first["raw_id"])[1]
        other = Workspace(self.source, "project", "original", "3" * 40)
        second = other.analyze("kinetics", first["filename"], raw, {}, "synthetic")
        report = self.replay()
        self.assertTrue(report["ok"], report)
        rows = {row["original_run_id"]: row for row in report["runs"]}
        self.assertEqual(set(rows), {first["id"], second["id"]})
        self.assertEqual(rows[first["id"]]["original_code_commit"], "1" * 40)
        self.assertEqual(rows[second["id"]]["original_code_commit"], "3" * 40)
        self.assertEqual(rows[first["id"]]["replayed_run_id"], rows[second["id"]]["replayed_run_id"])

    def test_corrupt_original_output_is_reported_and_recomputed(self):
        run = self.add_kinetics()
        manifest = self.store.manifest(run["id"])
        result = next(item for item in manifest["artifacts"] if item["artifact_id"] == manifest["outputs"][0])
        expected = result["sha256"]
        bad = b"x" * result["size_bytes"]
        (self.store.blobs / expected[:2] / expected).write_bytes(bad)
        report = self.replay()
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "failed")
        row = report["runs"][0]
        self.assertEqual(row["status"], "mismatch")
        comparison = row["artifacts"]["result"]
        self.assertFalse(comparison["match"])
        self.assertFalse(comparison["original"]["verified"])
        self.assertEqual(comparison["original"]["actual_sha256"], digest(bad))
        self.assertEqual(comparison["replayed"]["actual_sha256"], expected)
        self.assertTrue(comparison["replayed"]["verified"])

    def test_verified_output_drift_is_a_mismatch(self):
        self.add_kinetics()
        analyze = Workspace.analyze

        def changed_output(workspace, *args):
            result = analyze(workspace, *args)
            path = workspace.runs / result["id"] / "manifest.json"
            manifest = workspace.manifest(result["id"])
            artifact = next(item for item in manifest["artifacts"]
                            if item["artifact_id"] == manifest["outputs"][0])
            data = json_bytes({**result["result"], "activation_energy": 0})
            checksum = digest(data)
            workspace._store(checksum, data)
            artifact.update(sha256=checksum, size_bytes=len(data))
            path.write_bytes(json_bytes(manifest))
            return result

        with patch.object(Workspace, "analyze", changed_output):
            report = self.replay()
        self.assertFalse(report["ok"])
        result = report["runs"][0]["artifacts"]["result"]
        self.assertFalse(result["match"])
        self.assertTrue(result["original"]["verified"])
        self.assertTrue(result["replayed"]["verified"])

    def test_invalid_reference_does_not_block_other_runs(self):
        name, raw, options, reference = md_case()
        ref_bytes = json.dumps(reference).encode()
        bad_run = self.store.analyze("md", name, raw, options, "synthetic", ("reference.json", ref_bytes))
        good_run = self.add_kinetics()
        checksum = digest(ref_bytes)
        (self.store.blobs / checksum[:2] / checksum).unlink()
        report = self.replay()
        rows = {row["original_run_id"]: row for row in report["runs"]}
        self.assertTrue(rows[good_run["id"]]["artifacts"]["result"]["match"])
        bad = rows[bad_run["id"]]
        self.assertEqual(bad["status"], "mismatch")
        self.assertIsNone(bad["replayed_run_id"])
        self.assertIsNone(bad["artifacts"]["reference"]["original"]["actual_sha256"])

    def test_details_and_extracted_vasp_members_are_verified(self):
        run = self.store.analyze("adsorption", *vasp_case(), "synthetic")
        artifacts = {item["name"]: item for item in run["artifacts"]}
        details = artifacts["details.json"]
        member_name = "bulk/vasprun.xml"
        member = artifacts[member_name]
        for artifact in (details, member):
            checksum = artifact["sha256"]
            (self.store.blobs / checksum[:2] / checksum).write_bytes(b"damaged artifact")
        report = self.replay()
        self.assertFalse(report["ok"])
        row = report["runs"][0]
        self.assertEqual(row["status"], "mismatch")
        self.assertTrue(row["artifacts"]["result"]["match"])
        for slot, artifact in (("details", details), (f"artifact:derived:{member_name}", member)):
            comparison = row["artifacts"][slot]
            self.assertFalse(comparison["match"])
            self.assertEqual(comparison["original"]["actual_sha256"], digest(b"damaged artifact"))
            self.assertEqual(comparison["original"]["expected_sha256"], artifact["sha256"])
            self.assertEqual(comparison["replayed"]["actual_sha256"], artifact["sha256"])

    def test_unsupported_run_makes_mixed_replay_incomplete(self):
        good_run = self.add_kinetics()
        unsupported = self.add_kinetics("unsupported.csv")
        manifest = self.store.manifest(unsupported["id"])
        manifest["operation"] = "unknown.operation"
        (self.store.runs / unsupported["id"] / "manifest.json").write_bytes(json_bytes(manifest))
        report = self.replay()
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "failed")
        rows = {row["original_run_id"]: row for row in report["runs"]}
        self.assertEqual(rows[good_run["id"]]["status"], "matched")
        self.assertEqual(rows[unsupported["id"]]["status"], "skipped")

    def test_empty_project_is_reported_without_success(self):
        report = self.replay()
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["reason"], "no_runs")
        self.assertEqual(report["runs"], [])

    def test_rejects_destination_alias_and_source_run_link(self):
        run = self.add_kinetics()
        self.destination.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symbolic link"):
            self.replay()
        self.destination.unlink()

        run_dir = self.store.runs / run["id"]
        detached = self.root / "detached"
        run_dir.rename(detached)
        run_dir.symlink_to(detached, target_is_directory=True)
        before = (detached / "manifest.json").read_bytes()
        report = self.replay()
        self.assertFalse(report["ok"])
        row = report["runs"][0]
        self.assertEqual(row["status"], "error")
        self.assertIn("Symbolic link", row["error"])
        self.assertEqual((detached / "manifest.json").read_bytes(), before)
        self.assertTrue(run_dir.is_symlink())

    def test_requires_fresh_separate_destination(self):
        with self.assertRaisesRegex(ValueError, "separate"):
            replay_project(self.source, "project", self.project / "output", "2" * 40)
        self.assertFalse((self.project / "output").exists())
        self.destination.mkdir()
        canary = self.destination / "keep"
        canary.write_text("original")
        with self.assertRaisesRegex(ValueError, "empty"):
            self.replay()
        self.assertEqual(canary.read_text(), "original")
