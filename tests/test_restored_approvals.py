"""A restored copy retains approval evidence even when dispatch is enabled by the caller."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from apps.server import make_server, plan_spec
from packages.agent.approvals import ApprovalStore, RestoredApprovalError
from packages.agent.backup import backup_project, restore_project
from test_a5_workbench import md_case


class RestoredApprovals(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.project = self.root / "projects" / "verify"
        self.scheduler = Mock()
        self.scheduler.submit.return_value = "42"
        self.source = ApprovalStore(self.root, "verify", "owner", self.scheduler)

    def freeze(self):
        (self.project / "restored-project.json").write_text(json.dumps({
            "project": "verify", "archive_sha256": "c" * 64,
        }))
        self.scheduler.reset_mock()
        return ApprovalStore(self.root, "verify", "reviewer", self.scheduler)

    def test_older_snapshot_cannot_dispatch_pending_retryable_or_unknown_plans(self):
        spec = {"mode": "slurm-synthetic", "workflow": "synthetic-v100", "origin": "synthetic"}
        pending = self.source.create(dict(spec, cpus=1))
        retry = self.source.create(dict(spec, cpus=2))
        self.scheduler.prepare.side_effect = ValueError("preflight unavailable")
        retry = self.source.confirm(retry["id"], retry["digest"])
        self.scheduler.prepare.side_effect = None
        self.scheduler.submit.side_effect = TimeoutError("receipt unavailable")
        unknown = self.source.create(dict(spec, cpus=3))
        unknown = self.source.confirm(unknown["id"], unknown["digest"])
        self.assertEqual([r["state"] for r in (pending, retry, unknown)], ["pending", "retryable", "unknown"])
        historical = self.source.list()
        restored = self.freeze()
        for plan in (pending, retry):
            with self.assertRaises(RestoredApprovalError):
                restored.confirm(plan["id"], plan["digest"])
        with self.assertRaises(RestoredApprovalError):
            restored.create(dict(spec, cpus=4))
        with self.assertRaises(RestoredApprovalError):
            restored.reconcile(unknown["id"])
        self.assertEqual(restored.confirm(unknown["id"], unknown["digest"]), unknown)
        self.assertEqual(restored.list(), historical)
        self.assertEqual(self.scheduler.mock_calls, [])

    def test_settled_approval_is_idempotent_and_db_bytes_are_preserved(self):
        rec = self.source.create(dict(mode="slurm-synthetic", workflow="synthetic-v100", origin="synthetic"))
        rec = self.source.confirm(rec["id"], rec["digest"])
        original = self.source.path.read_bytes()
        restored = self.freeze()
        self.assertEqual(restored.get(rec["id"])["job_id"], "42")
        self.assertEqual(restored.confirm(rec["id"], rec["digest"]), rec)
        self.assertEqual(restored.reconcile(rec["id"]), rec)
        self.assertEqual(restored.path.read_bytes(), original)
        self.assertEqual(self.scheduler.mock_calls, [])

    def test_pending_backup_cannot_resubmit_a_job_dispatched_after_snapshot(self):
        name, raw, options, _ = md_case()
        with make_server(self.root, "verify", "owner", 0, synthetic_submission=True) as live:
            source = live.workspace.analyze("md", name, raw, options, "synthetic")
            spec = plan_spec(live.workspace, dict(run_id=source["id"], workflow="synthetic-v100",
                                                 cpus=1, gpus=1, minutes=1), True)
            pending = self.source.create(spec)
        archive = self.root / "pending.zip"
        sha = backup_project(self.root, "verify", archive)["archive_sha256"]
        self.assertEqual(self.source.confirm(pending["id"], pending["digest"])["job_id"], "42")
        recovered = self.root / "separate"
        restore_project(archive, recovered, expected_sha256=sha)
        with make_server(recovered, "verify", "reviewer", 0, synthetic_submission=True) as server:
            self.assertFalse(server.synthetic_submission)
            self.assertEqual(server.approvals.get(pending["id"]), pending)
            with self.assertRaises(RestoredApprovalError):
                server.approvals.confirm(pending["id"], pending["digest"])
        self.scheduler.submit.assert_called_once()

    def test_legacy_snapshot_without_approvals_stays_empty(self):
        self.source.path.unlink()
        restored = self.freeze()
        self.assertEqual(restored.list(), [])
        with self.assertRaises(FileNotFoundError):
            restored.get("plan-" + "a" * 64)
        self.assertFalse(restored.path.exists())

    def test_invalid_restore_marker_fails_closed(self):
        (self.project / "restored-project.json").write_text('{"project":"different"}')
        with self.assertRaisesRegex(ValueError, "recovery marker"):
            ApprovalStore(self.root, "verify", "reviewer", self.scheduler)
