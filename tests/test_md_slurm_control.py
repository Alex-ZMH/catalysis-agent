import json
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch

from packages.agent.approvals import ApprovalStore
from packages.agent.md_slurm import MDSlurm, SchedulerUnavailable, _Controller, _profile
from packages.science.md_job import _script


CONFIG = {
    "steps": 40, "dt_ps": 0.001, "integrator": "nvt", "damping_ps": 0.1,
    "initial_temperature_K": 100, "seed": 5993, "restart_every": 10,
    "thermo_every": 10, "dump_every": 10, "boundary": ["p", "p", "p"],
    "force_field": {"style": "lj/cut", "cutoff_A": 4, "pairs": [
        {"i": 1, "j": 1, "epsilon_eV": 0.01, "sigma_A": 1.6}]},
}
OPTIONS = dict(config=CONFIG, request_id="0316c532-6b9c-4483-a73d-e086d2c12100",
               cpus=1, gpus=0, minutes=2)


class Recorder:
    def __init__(self):
        self.profile = _profile({"engine": "/usr/bin/true"})
        self.calls = []

    def call(self, operation, *args):
        self.calls.append((operation, *args))
        if operation == "submit":
            raise SchedulerUnavailable("lost reply")
        if operation == "lookup":
            return "452"
        if operation == "status":
            return "CANCELLED", "None"


class MDSlurmTests(unittest.TestCase):
    def setUp(self):
        work = TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        self.broker = Recorder()
        self.scheduler = MDSlurm(self.root, "sample", self.broker)
        self.approval = ApprovalStore(self.root, "sample", "operator", md_scheduler=self.scheduler)

    def plan(self):
        return self.scheduler.create(self.approval, OPTIONS, lambda: (
            "POSCAR", b"synthetic source", None, {"project_id": "sample", "operator_id": "operator"}
        ))

    def test_confirmation_race_and_receipt_only_recovery(self):
        plan = self.plan()
        retry = self.scheduler.create(self.approval, OPTIONS, lambda: self.fail("reopened source"))
        self.assertEqual(retry["id"], plan["id"])
        self.assertFalse(self.broker.calls)
        replies = []
        def confirm():
            replies.append(self.approval.confirm(plan["id"], plan["digest"]))
        workers = [Thread(target=confirm) for _ in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertEqual(len(replies), 8)
        self.assertEqual([call[0] for call in self.broker.calls], ["submit"])
        self.assertEqual(self.approval.get(plan["id"])["state"], "unknown")
        restored = ApprovalStore(self.root, "sample", "operator", md_scheduler=self.scheduler)
        self.assertEqual(restored.confirm(plan["id"], plan["digest"])["state"], "unknown")
        self.assertEqual(restored.reconcile(plan["id"])["job_id"], "452")
        self.assertEqual(restored.confirm(plan["id"], plan["digest"])["job_id"], "452")
        self.assertEqual([call[0] for call in self.broker.calls], ["submit", "lookup"])

    def test_controller_persists_claim_before_ambiguous_sbatch(self):
        plan = self.plan()
        self.scheduler.prepare(plan)
        directory = self.scheduler._plan_dir(plan["id"])
        controller = _Controller(self.root, self.broker.profile)
        with patch("packages.agent.md_slurm._slurm", side_effect=TimeoutExpired("sbatch", 1)) as slurm:
            with self.assertRaises(SchedulerUnavailable):
                controller.submit(directory, plan["id"])
            self.assertTrue((directory / "dispatch.claimed").is_file())
            with self.assertRaisesRegex(SchedulerUnavailable, "already claimed"):
                _Controller(self.root, self.broker.profile).submit(directory, plan["id"])
            self.assertEqual(slurm.call_count, 1)

    def test_terminal_checkpoint_status_and_explicit_restart(self):
        original = self.plan()
        self.approval.confirm(original["id"], original["digest"])
        plan = self.approval.reconcile(original["id"])
        run = self.scheduler._plan_dir(plan["id"]) / "run"
        run.mkdir()
        (run / "checkpoint.10").write_bytes(b"published checkpoint")
        (run / "checkpoint.tmp").write_bytes(b"incomplete checkpoint")
        (run / "run.json").write_text(json.dumps(dict(slurm_job_id="452", status="interrupted")))
        (run / "log.lammps").write_text("   15 .015 99 -4 1 -3 4\n")
        for artifact in run.iterdir():
            artifact.chmod(0o600)
        status = self.scheduler.status(plan)
        self.assertEqual(status["progress"], dict(step=15, start_step=0, target_step=40, fraction=.375))
        self.assertTrue(status["can_restart"])
        self.assertEqual(status["checkpoints"], [{"id": "checkpoint.10", "step": 10}])
        request = {"checkpoint": "checkpoint.10", "steps": 20, "cpus": 1, "gpus": 0, "minutes": 2}
        resumed = self.scheduler.restart(self.approval, plan, request)
        self.assertEqual(resumed, self.scheduler.restart(self.approval, plan, request))
        self.assertEqual(resumed["state"], "pending")
        self.assertEqual(resumed["spec"]["restart"],
                         dict(plan_id=plan["id"], job_id="452", checkpoint="checkpoint.10", step=10, steps=20))
        self.assertEqual(resumed["spec"]["target_step"], 30)
        self.assertEqual(sum(call[0] == "submit" for call in self.broker.calls), 1)

    def test_restart_uses_stored_state_and_publishes_checkpoint_atomically(self):
        script = _script(CONFIG, ["pair_style lj/cut 4"], {"atom_count": 4}, restarting=True).decode()
        self.assertIn("read_restart source.restart", script)
        self.assertNotIn("velocity all create", script)
        self.assertNotIn("read_data", script)
        self.assertIn("fix md_integrator all nvt", script)
        self.assertIn("dump_modify md_trajectory sort id units yes first yes", script)
        self.assertIn('"write_restart checkpoint.tmp" "shell mv checkpoint.tmp checkpoint.$(step:%.0f)"', script)

    def test_cancel_is_scoped_to_matching_controller_job(self):
        plan = self.plan()
        self.scheduler.prepare(plan)
        controller = _Controller(self.root, self.broker.profile)
        directory = self.scheduler._plan_dir(plan["id"])
        def result(*args, **kwargs):
            return CompletedProcess(args, 0, stdout=(
                "JobId=452 JobName=other UserId=worker(1) JobState=RUNNING Reason=None\n"
            ), stderr="")
        with patch("packages.agent.md_slurm._slurm", side_effect=result) as slurm:
            with self.assertRaisesRegex(SchedulerUnavailable, "matching Slurm"):
                controller.cancel(directory, plan["id"], "452")
            self.assertEqual([call.args[0] for call in slurm.call_args_list], ["scontrol"])


if __name__ == "__main__":
    unittest.main()
