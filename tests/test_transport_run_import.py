"""Focused regression tests for native Slurm transport project runs."""

from email.message import Message
from io import BytesIO
import json
from hashlib import sha256
import tempfile
import unittest

from apps.server import form_fields, resolve_plan_transport, resolve_uploaded_transport
from packages.agent.records import validate_run
from packages.agent.workspace import Workspace


PROFILE = b"""# Chunk-averaged data for fix bins and group all
# Timestep Number-of-chunks Total-count
# Chunk Coord1 Ncount temp v_q
0 2 32
1 -0.5 16 300 -2
2 0.5 16 310 -2
"""
GLOBAL = b"# TimeStep v_q\n0 -2\n"
VELOCITY = b"# Timestep Number-of-chunks Total-count\n# Chunk Coord1 Ncount vx\n0 2 32\n1 -0.5 16 1\n2 0.5 16 2\n"
PROFILE_STRESS = b"# Timestep Number-of-chunks Total-count\n# Chunk Coord1 Ncount v_q\n0 2 32\n1 -0.5 16 3\n2 0.5 16 3\n"


def metadata():
    return json.dumps({
        "schema": "md_transport.v1",
        "lammps_units": "metal",
        "provenance": {
            "plan_id": "plan-transport-01",
            "job_id": "1023_7",
            "source_files": ["transport_profile.dat", "transport_global.dat", "transport_metadata.json"],
        },
    }).encode()


class TransportRunImportTests(unittest.TestCase):
    def test_multipart_sidecars_and_verified_raw_lineage(self):
        boundary = "----transport-run"
        parts = []
        for key, value in (("kind", "md_transport"), ("origin", "research"),
                           ("options", json.dumps({"mode": "conductivity"}))):
            parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n").encode())
        for key, filename, content in (("file", "transport_profile.dat", PROFILE),
                                       ("transport_global", "transport_global.dat", GLOBAL),
                                       ("transport_metadata", "transport_metadata.json", metadata())):
            parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; "
                          f"filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode())
            parts.extend([content, b"\r\n"])
        parts.append(f"--{boundary}--\r\n".encode())
        headers = Message()
        headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
        fields = form_fields(headers, b"".join(parts))
        options = {
            "mode": "conductivity", "columns": {"position": "Coord1", "field": "temp", "flux": "v_q"},
            "units": {"position": "angstrom", "field": "K", "flux": "eV/(angstrom^2*ps)"},
            "source_plan_id": "plan-transport-01", "source_job_id": "1023_7",
        }
        with tempfile.TemporaryDirectory() as folder:
            store = Workspace(folder, "project", "analyst", "1" * 40)
            view = store.analyze(fields["kind"], *fields["file"], options, fields["origin"],
                                 transport_files={key: fields[key] for key in fields if key.startswith("transport_")},
                                 transport_fields={})
            self.assertEqual(view["execution"]["plan_id"], "plan-transport-01")
            self.assertEqual(view["execution"]["job_id"], "1023_7")
            self.assertFalse(view["execution"]["verified"])
            self.assertEqual(set(view["raw_ids"]), {"profile", "global_flux", "metadata"})
            validate_run(store.manifest(view["id"]))
            records = {record["artifact_id"]: record for record in store.manifest(view["id"])["artifacts"]}
            for artifact_id in view["raw_ids"].values():
                _, raw = store.download(view["id"], artifact_id)
                self.assertEqual(sha256(raw).hexdigest(), records[artifact_id]["sha256"])

    def test_mismatched_request_id_is_rejected(self):
        options = {"mode": "conductivity", "columns": {"position": "Coord1", "field": "temp", "flux": "v_q"},
                   "units": {"position": "angstrom", "field": "K", "flux": "eV/(angstrom^2*ps)"}}
        with tempfile.TemporaryDirectory() as folder:
            store = Workspace(folder, "project", "analyst", "1" * 40)
            with self.assertRaisesRegex(ValueError, "plan ID"):
                store.analyze("md_transport", "transport_profile.dat", PROFILE, options, "research",
                              transport_files={
                                  "transport_global": ("transport_global.dat", GLOBAL),
                                  "transport_metadata": ("transport_metadata.json", metadata()),
                              },
                              transport_fields={"transport_plan_id": "plan-forged"})
            self.assertEqual(store.recent(), [])

    def test_single_file_transport_preserves_existing_path(self):
        options = {"mode": "conductivity", "columns": {"position": "Coord1", "field": "temp", "flux": "v_q"},
                   "units": {"position": "angstrom", "field": "K", "flux": "eV/(angstrom^2*ps)"}}
        with tempfile.TemporaryDirectory() as folder:
            store = Workspace(folder, "project", "analyst", "1" * 40)
            view = store.analyze("md_transport", "transport_profile.dat", PROFILE, options, "research")
            self.assertIsNone(view["execution"])
            self.assertNotIn("plan_id", view["result"]["source"])
            validate_run(store.manifest(view["id"]))

    def test_uploaded_claim_is_never_verified(self):
        class Approvals:
            def get(self, plan_id):
                return {"id": plan_id, "state": "submitted", "job_id": "1023_7"}

        files = {"transport_global": ("transport_global.dat", GLOBAL),
                 "transport_metadata": ("transport_metadata.json", metadata())}
        options = {"mode": "conductivity", "columns": {"position": "Coord1", "field": "temp", "flux": "v_q"},
                   "units": {"position": "angstrom", "field": "K", "flux": "eV/(angstrom^2*ps)"}}
        verification = resolve_uploaded_transport(Approvals(), "transport_profile.dat", PROFILE, options, files)
        self.assertFalse(verification["execution"]["verified"])
        self.assertIn("上传", verification["execution"]["verification_reason"])

    def test_paired_velocity_source_uses_explicit_role_adapter(self):
        options = {"mode": "viscosity",
                   "columns": {"position": "Coord1", "field": "vx", "flux": "v_q"},
                   "units": {"position": "angstrom", "field": "angstrom/ps", "flux": "Pa"},
                   "stress_convention": "momentum_flux"}
        paired_metadata = json.dumps({"provenance": {
            "plan_id": "plan-transport-01", "job_id": "1023_7",
            "source_files": ["transport_profile.dat", "transport_velocity.dat",
                              "transport_metadata.json"],
        }}).encode()
        files = {"transport_velocity": ("transport_velocity.dat", VELOCITY),
                 "transport_metadata": ("transport_metadata.json", paired_metadata)}
        with tempfile.TemporaryDirectory() as folder:
            store = Workspace(folder, "project", "analyst", "1" * 40)
            with self.assertRaisesRegex(ValueError, "plan ID"):
                store.analyze("md_transport", "transport_profile.dat", PROFILE_STRESS, options, "research",
                              transport_files=files,
                              transport_fields={"transport_plan_id": "plan-forged"})
            view = store.analyze("md_transport", "transport_profile.dat", PROFILE_STRESS, options, "research",
                                 transport_files=files)
            self.assertEqual(view["result"]["source"]["columns"]["field"], "vx")
            self.assertFalse(view["execution"]["verified"])

    def test_authorized_plan_artifacts_can_be_collected_server_side(self):
        plan = {
            "id": "plan-transport-01", "state": "submitted", "job_id": "1023_7",
            "spec": {"workflow": "md-lammps", "mode": "slurm-md", "config": {
                "transport_sampling": {"enabled": True, "channels": ["heat_profile", "heat_global"],
                                        "fields": ["temperature"], "outputs": {
                                            "profile": "transport_profile.dat",
                                            "global_flux": "transport_global.dat",
                                            "metadata": "transport_metadata.json",
                                        }}}},
        }

        class Approvals:
            def get(self, plan_id):
                self.asserted = plan_id
                return plan

        class Scheduler:
            values = {"transport_profile.dat": PROFILE, "transport_global.dat": GLOBAL,
                      "transport_metadata.json": metadata()}

            def artifact(self, current, name):
                if current is not plan:
                    raise AssertionError("artifact read used a different plan record")
                raw = self.values[name]
                return BytesIO(raw), len(raw)

        options = {"mode": "conductivity", "columns": {"position": "Coord1", "field": "temp", "flux": "v_q"},
                   "units": {"position": "angstrom", "field": "K", "flux": "eV/(angstrom^2*ps)"}}
        normalized, files, verification = resolve_plan_transport(
            Approvals(), Scheduler(), plan["id"], plan["job_id"], options, 8 * 1024 * 1024)
        self.assertTrue(verification["execution"]["verified"])
        self.assertIn("transport_plan", files)
        primary = files.pop("transport_profile")
        with tempfile.TemporaryDirectory() as folder:
            store = Workspace(folder, "project", "analyst", "1" * 40)
            view = store.analyze("md_transport", *primary, normalized, "research",
                                 transport_files=files,
                                 transport_fields={"transport_plan_id": plan["id"],
                                                   "transport_job_id": plan["job_id"]},
                                 transport_verification=verification)
            self.assertTrue(view["execution"]["verified"])
            self.assertIn("plan", view["raw_ids"])
            validate_run(store.manifest(view["id"]))


if __name__ == "__main__":
    unittest.main()
