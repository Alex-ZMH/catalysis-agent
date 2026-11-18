"""Exercise the scheduler boundary with fake Slurm and CUDA."""
import copy
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import NamedTemporaryFile, TemporaryDirectory
import unittest
from unittest.mock import patch

from packages.agent import slurm


def plan():
    digest = "a" * 64
    return {
        "id": "plan-" + digest, "digest": digest,
        "spec": dict(
            run_id="run-" + "b" * 64, run_kind="md", origin="synthetic",
            source_name="example.dump", source_sha256="c" * 64,
            source_id="artifact-source", source_commit="d" * 40,
            workflow="synthetic-v100", cpus=2, gpus=1, minutes=2,
            mode="slurm-synthetic", policy_id="a6-synthetic-v100-v1",
        ),
    }


def response(stdout="", code=0):
    return subprocess.CompletedProcess([], code, stdout, "fake error" if code else "")


class SyntheticSlurmTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        self.adapter = slurm.SyntheticSlurm(Path(directory) / "project data")
        self.plan = plan()
        self.run_slurm = self.enterContext(patch.object(slurm.subprocess, "run"))
        self.preflight = self.enterContext(patch.object(slurm.shutil, "which", return_value="/usr/bin/test"))
        self.uid = os.getuid()

    def test_reject_invalid_inputs_before_files_or_commands(self):
        for changes in (
            dict(command="hostname"), dict(path="/data/real.dat"), dict(source_name="../real.dat"),
            dict(origin="research"), dict(workflow="vasp"), dict(mode="plan-only"),
            dict(policy_id="other"), dict(run_id="../../inputs"), dict(cpus=True),
            dict(gpus=2), dict(minutes=3),
        ):
            with self.subTest(changes=changes):
                invalid = copy.deepcopy(self.plan)
                invalid["spec"].update(changes)
                for action in (self.adapter.prepare, self.adapter.submit, self.adapter.lookup):
                    with self.assertRaises(ValueError):
                        action(invalid)
        self.assertFalse(self.adapter.directory.exists())
        self.run_slurm.assert_not_called()

    def test_preflight_and_script_integrity(self):
        self.preflight.return_value = None
        with self.assertRaisesRegex(RuntimeError, "Missing required executable"):
            self.adapter.prepare(self.plan)
        self.preflight.return_value = "/usr/bin/test"
        script = self.adapter.prepare(self.plan)
        content = script.read_text()
        self.assertEqual(self.adapter.prepare(self.plan).read_text(), content)
        script.write_text("#!/bin/sh\nhostname\n")
        with self.assertRaisesRegex(ValueError, "approved template"):
            self.adapter.submit(self.plan)
        script.unlink()
        script.symlink_to(__file__)
        with self.assertRaises(OSError):
            self.adapter.submit(self.plan)
        self.run_slurm.assert_not_called()

    def test_reject_symlink_plan_directory(self):
        self.adapter.directory.mkdir()
        (self.adapter.directory / self.plan["id"]).symlink_to(self.adapter.directory)
        with self.assertRaisesRegex(ValueError, "Unsafe Slurm directory"):
            self.adapter.prepare(self.plan)
        self.run_slurm.assert_not_called()

    def test_single_submission_uses_clean_environment_and_durable_receipt(self):
        directory = self.adapter.prepare(self.plan).parent
        self.run_slurm.return_value = response("123;cluster\n")
        with patch.dict(os.environ, {"SBATCH_ARRAY_INX": "1-999", "SLURM_JOB_ID": "99"}), \
                patch.object(self.adapter, "prepare", side_effect=AssertionError("duplicate prepare")):
            self.assertEqual(self.adapter.submit(self.plan), "123")
        self.run_slurm.assert_called_once()
        args = self.run_slurm.call_args.args[0]
        options = self.run_slurm.call_args.kwargs
        self.assertEqual(args, (
            "sbatch", "--parsable", "--partition=gpu", "--gres=gpu:v100:1",
            "--nodes=1", "--ntasks=1", "--cpus-per-task=2", "--time=2", "--export=NIL",
            "--no-requeue", f"--job-name={self.plan['id']}", f"--chdir={directory}",
            "--output=slurm-%j.out", "--error=slurm-%j.err",
        ))
        self.assertEqual(options["cwd"], directory)
        self.assertEqual(options["input"], (directory / "synthetic-v100.sh").read_text())
        self.assertEqual(set(options["env"]), {"PATH", "LC_ALL"})
        self.run_slurm.side_effect = [response(), response()]
        self.assertEqual(self.adapter.lookup(self.plan), "123")

    def test_failed_or_malformed_submission_has_no_receipt(self):
        directory = self.adapter.prepare(self.plan).parent
        for result in (response("123", code=1), response("0"), response("123 extra")):
            self.run_slurm.reset_mock()
            self.run_slurm.return_value = result
            with self.assertRaises(RuntimeError):
                self.adapter.submit(self.plan)
            self.run_slurm.assert_called_once()
        self.assertEqual(list(directory.glob("*.json")), [])

    def test_lookup_live_history_loss_and_controller_failure(self):
        marker = self.plan["id"]
        history = f"JobId=123 JobName={marker} UserId=operator({self.uid}) JobState=COMPLETED\n"
        for sources, expected in (
            ([response(history), response()], "123"),
            ([response(history, code=1), response(f"456|{marker}|{self.uid}\n")], "456"),
            ([response(), response(f"456|{marker}|{self.uid + 1}\n")], None),
            ([response(), response()], None),
        ):
            self.run_slurm.reset_mock()
            self.run_slurm.side_effect = sources
            self.assertEqual(self.adapter.lookup(self.plan), expected)
            self.assertEqual([c.args[0][0] for c in self.run_slurm.call_args_list], ["scontrol", "squeue"])
        self.run_slurm.side_effect = [response(history, code=1), response(code=1)]
        with self.assertRaisesRegex(RuntimeError, "Unable to query"):
            self.adapter.lookup(self.plan)

    def test_duplicate_matches_and_conflicting_receipt_owner(self):
        marker = self.plan["id"]
        self.run_slurm.side_effect = [response(), response(f"123|{marker}|{self.uid}\n456|{marker}|{self.uid}\n")]
        with self.assertRaisesRegex(RuntimeError, "Conflicting"):
            self.adapter.lookup(self.plan)
        self.adapter.prepare(self.plan)
        self.run_slurm.side_effect = [response("123")]
        self.adapter.submit(self.plan)
        self.run_slurm.side_effect = [response(), response(f"123|{marker}|{self.uid + 1}\n")]
        with self.assertRaisesRegex(RuntimeError, "Conflicting"):
            self.adapter.lookup(self.plan)

    def test_gpu_payload_produces_completion_receipt(self):
        directory = self.adapter.prepare(self.plan).parent

        class FakeCuda:
            def __getattr__(self, name):
                return lambda *args: 0

            def cuDeviceGetCount(self, count):
                count._obj.value = 1
                return 0

            def cuDeviceGetName(self, name, *_):
                name.value = b"Tesla V100"
                return 0

            def cuMemcpyDtoH_v2(self, values, address, size):
                values[:] = [i * i + 7 for i in range(32)]
                return 0

        # The real job uses the sbatch working directory; only redirect temp I/O here.
        def temporary(**kwargs):
            return NamedTemporaryFile(**{**kwargs, "dir": directory})

        replace = os.replace

        def place(src, dst):
            replace(src, directory / dst)

        key = self.plan["id"]
        with patch.object(ctypes, "CDLL", return_value=FakeCuda()), \
                patch.dict(os.environ, {"CUDA_VISIBLE_DEVICES": "0", "SLURM_JOB_ID": "123"}), \
                patch.object(sys, "argv", ["-", key, self.plan["digest"], key]), \
                patch("tempfile.NamedTemporaryFile", side_effect=temporary), \
                patch.object(os, "replace", side_effect=place):
            exec(compile(slurm._PROBE, "<synthetic-v100>", "exec"), {})
        path = directory / "result-123.json"
        receipt = json.loads(path.read_text())
        self.assertEqual(receipt["device"], "Tesla V100")
        self.assertEqual(receipt["values"][-1], 968)
        self.run_slurm.side_effect = [response(), response()]
        self.assertEqual(self.adapter.lookup(self.plan), "123")
        receipt["marker"] = "other"
        path.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(RuntimeError, "Invalid Slurm receipt"):
            self.adapter.lookup(self.plan)
