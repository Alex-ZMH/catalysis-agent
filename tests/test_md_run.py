"""Exercise the operator CLI with local fixture processes only."""
import json
from io import BytesIO
import os
from pathlib import Path
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from zipfile import ZipFile

from packages.science import md_job


POSCAR = """Two argon atoms
1
8 0 0
0 8 0
0 0 8
Ar
2
Direct
0.25 0.25 0.25
0.5 0.5 0.5
"""
CONFIG = {
    "integrator": "nve", "steps": 2, "dt_ps": 0.001, "initial_temperature_K": 20,
    "seed": 12345, "thermo_every": 1, "dump_every": 1, "boundary": ["p", "p", "p"],
    "force_field": {"style": "lj/cut", "cutoff_A": 2.5,
                    "pairs": [{"i": 1, "j": 1, "epsilon_eV": 0.01, "sigma_A": 2.0}]},
}
TRAJECTORY = """ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
2
ITEM: BOX BOUNDS pp pp pp
0 8
0 8
0 8
ITEM: ATOMS id type x y z
1 1 2 2 2
2 1 4 4 4
"""


class MDRunTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.structure = self.root / "POSCAR"
        self.structure.write_text(POSCAR, encoding="utf-8")
        self.config = self.root / "job.json"
        self.config.write_text(json.dumps(CONFIG), encoding="utf-8")
        self.engine = self.root / "fake-lammps"
        self.out = self.root / "job"
        self.write_engine("success")

    def write_engine(self, mode):
        script = f"""#!{sys.executable}
from pathlib import Path
import sys
import time

if sys.argv[1:] == ["-help"]:
    print("LAMMPS (fixture)")
    sys.exit(0)

assert sys.argv[1:] == ["-in", "in.md", "-log", "log.lammps"]
assert "read_data structure.data" in Path("in.md").read_text()
assert Path("structure.data").is_file()
assert Path("md-config.json").is_file()
Path("log.lammps").write_text("Step Temp PotEng\\n0 20 -0.01\\nLoop time\\nStep Temp PotEng\\n2 22 -0.02\\n")
print("fixture solver started", flush=True)
print("fixture diagnostic", file=sys.stderr, flush=True)
if {mode!r} == "interrupt":
    time.sleep(15)
if {mode!r} == "fail":
    sys.exit(7)
if {mode!r} != "incomplete":
    Path("trajectory.lammpstrj").write_text({TRAJECTORY!r})
    Path("final.data").write_text("fixture final data")
    Path("final.restart").write_bytes(b"fixture restart")
"""
        self.engine.write_text(script, encoding="utf-8")
        self.engine.chmod(0o700)

    def argv(self, engine=None):
        return [sys.executable, "-m", "packages.md_run", "--structure", str(self.structure),
                "--config", str(self.config), "--engine", str(engine or self.engine),
                "--output-dir", str(self.out)]

    def run_cli(self, engine=None):
        return subprocess.run(self.argv(engine), capture_output=True, text=True, timeout=15,
                              env={**os.environ, "SLURM_JOB_ID": "123456"})

    def record(self, process, status, exit_code):
        self.assertEqual(process.returncode, exit_code, (process.stdout, process.stderr))
        result = json.loads(process.stdout)
        self.assertEqual(result, json.loads((self.out / "run.json").read_text()))
        self.assertEqual(result["status"], status)
        self.assertIsNotNone(result["finished_at"])
        self.assertGreater(result["elapsed_seconds"], 0)
        return result

    def test_success_logs_provenance_and_preserves_native_outputs(self):
        run = self.record(self.run_cli(), "completed", 0)
        self.assertEqual(run["slurm_job_id"], "123456")
        self.assertTrue(run["code_commit"])
        self.assertEqual(run["parameters"]["steps"], 2)
        self.assertEqual(run["units"], "metal")
        self.assertEqual(run["engine"]["version"], "LAMMPS (fixture)")
        self.assertEqual(run["engine"]["argv"], [str(self.engine), "-in", "in.md", "-log", "log.lammps"])
        self.assertEqual(run["engine"]["returncode"], 0)
        files = {"source/POSCAR", "md-config.json", "in.md", "structure.data", "stdout.log", "stderr.log",
                 "engine-help.stdout.log", "engine-help.stderr.log", "log.lammps",
                 "trajectory.lammpstrj", "final.data", "final.restart", "thermo.jsonl"}
        self.assertEqual(set(run["files"]), files)
        self.assertEqual((self.out / "trajectory.lammpstrj").read_text(), TRAJECTORY)
        self.assertEqual((self.out / "source" / "POSCAR").read_text(), POSCAR)
        self.assertIn("fixture solver started", (self.out / "stdout.log").read_text())
        self.assertIn("fixture diagnostic", (self.out / "stderr.log").read_text())
        rows = [json.loads(line) for line in (self.out / "thermo.jsonl").read_text().splitlines()]
        self.assertEqual(rows, [{"Step": 0, "Temp": 20, "PotEng": -0.01},
                                {"Step": 2, "Temp": 22, "PotEng": -0.02}])
        self.assertEqual(run["thermo_rows"], 2)

    def test_failed_solver_keeps_raw_logs_and_thermo(self):
        self.write_engine("fail")
        run = self.record(self.run_cli(), "failed", 1)
        self.assertEqual(run["phase"], "solver")
        self.assertEqual(run["engine"]["returncode"], 7)
        self.assertEqual(run["thermo_rows"], 2)
        self.assertIn("stderr.log", run["files"])
        self.assertNotIn("trajectory.lammpstrj", run["files"])


    def test_downloaded_eam_bundle_regenerates_script_and_keeps_provenance(self):
        potential = b"fixture\nfixture\nfixture\n1 Ar\n2 1 2 1 3\nfixture tables\n"
        provenance = {"project_id": "alpha", "run_id": "run-legacy",
                      "artifact_id": "art-structure", "source_filename": "site/POSCAR",
                      "potential_filename": "operator-Ar.setfl"}
        config = {**CONFIG, "force_field": {"style": "eam/alloy", "elements": ["Ar"]}}
        generated = md_job.build_job("POSCAR", POSCAR.encode(), config,
                                     potential=potential, provenance=provenance)
        bundle = self.root / "downloaded.zip"
        with ZipFile(BytesIO(generated)) as src, ZipFile(bundle, "w") as target:
            for name in src.namelist():
                data = b"shell echo ignored-uploaded-script" if name == "in.md" else src.read(name)
                target.writestr(name, data)
        command = [sys.executable, "-m", "packages.md_run", "--job-bundle", str(bundle),
                   "--engine", str(self.engine), "--output-dir", str(self.out)]
        process = subprocess.run(command, capture_output=True, text=True, timeout=15)
        run = self.record(process, "completed", 0)
        self.assertEqual(run["provenance"], provenance)
        self.assertEqual(run["inputs"]["job_bundle"], bundle.name)
        self.assertEqual(run["inputs"]["potential"], "operator-Ar.setfl")
        self.assertEqual((self.out / "potential.eam.alloy").read_bytes(), potential)
        regenerated = json.loads((self.out / "md-config.json").read_text())
        self.assertEqual(regenerated["provenance"], provenance)
        script = (self.out / "in.md").read_text()
        self.assertIn("pair_coeff * * potential.eam.alloy Ar", script)
        self.assertNotIn("ignored-uploaded-script", script)

        for flag in ("--structure", "--config", "--potential"):
            with self.subTest(flag=flag):
                bad = subprocess.run([*command, flag, str(self.config)], capture_output=True,
                                     text=True, timeout=15)
                self.assertEqual(bad.returncode, 2)

    def test_invalid_bundle_member_fails_before_engine(self):
        bundle = self.root / "bad.zip"
        with ZipFile(bundle, "w") as target:
            target.writestr("md-config.json", json.dumps(
                {"version": 1, "config": CONFIG, "files": {"source": "source/../POSCAR"}}))
        command = [sys.executable, "-m", "packages.md_run", "--job-bundle", str(bundle),
                   "--engine", str(self.engine), "--output-dir", str(self.out)]
        process = subprocess.run(command, capture_output=True, text=True, timeout=15)
        run = self.record(process, "failed", 1)
        self.assertIn("source member", run["error"])
        self.assertEqual(run["files"], [])

    def test_zero_exit_with_missing_outputs_is_failed(self):
        self.write_engine("incomplete")
        run = self.record(self.run_cli(), "failed", 1)
        self.assertEqual(run["engine"]["returncode"], 0)
        self.assertIn("trajectory.lammpstrj", run["error"])

    def test_interrupt_terminates_fixture_and_finalizes_record(self):
        self.write_engine("interrupt")
        with subprocess.Popen(self.argv(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
            try:
                deadline = time.monotonic() + 10
                stdout = self.out / "stdout.log"
                while time.monotonic() < deadline and process.poll() is None:
                    if stdout.exists() and "fixture solver started" in stdout.read_text():
                        break
                    time.sleep(0.05)
                else:
                    self.fail("Fixture solver did not start")
                process.send_signal(signal.SIGTERM)
                out, err = process.communicate(timeout=10)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.communicate(timeout=20)
        run = self.record(subprocess.CompletedProcess(self.argv(), process.returncode, out, err),
                          "interrupted", 128 + signal.SIGTERM)
        self.assertEqual(run["signal"], signal.SIGTERM)
        self.assertEqual(run["engine"]["returncode"], -signal.SIGTERM)
        self.assertEqual(run["thermo_rows"], 2)

    def test_rejects_relative_engine_and_keeps_existing_directory(self):
        run = self.record(self.run_cli("fake-lammps"), "failed", 1)
        self.assertIn("absolute path", run["error"])
        self.assertEqual(run["files"], [])
        before = (self.out / "run.json").read_bytes()
        again = self.run_cli()
        self.assertEqual(again.returncode, 1)
        self.assertEqual((self.out / "run.json").read_bytes(), before)

    def test_rejects_config_injected_script_before_starting_engine(self):
        self.config.write_text(json.dumps({**CONFIG, "script": "shell echo bad"}), encoding="utf-8")
        run = self.record(self.run_cli(), "failed", 1)
        self.assertEqual(run["phase"], "staging")
        self.assertEqual(run["files"], [])
