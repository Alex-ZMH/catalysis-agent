"""HTTP boundary between human-approved plans and the opt-in synthetic profile."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from apps.server import make_server
from test_a5_workbench import md_case


class WorkbenchPlans(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.http = make_server(Path(directory.name), "plans", "Astra", 0)
        self.addCleanup(self.http.server_close)
        thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.http.shutdown)
        name, contents, options, _ = md_case()
        source = self.http.workspace.analyze("md", name, contents, options, "synthetic")
        self.spec = dict(workflow="md-simulation", run_id=source["id"], cpus=2, gpus=1, minutes=2)
        self.base = f"http://127.0.0.1:{self.http.server_port}"

    def request(self, path, body=None, origin=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = self.base
        req = Request(self.base + path, headers=headers,
                      data=None if body is None else json.dumps(body).encode())
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as exc:
            return exc.code, json.load(exc)

    def test_default_plan_only_explicit_confirmation_and_replay(self):
        code, plan = self.request("/api/plans", self.spec)
        self.assertEqual(code, 200)
        self.assertEqual(plan["spec"]["mode"], "plan-only")
        self.assertEqual(plan["state"], "pending")
        self.assertEqual(self.request("/api/plans", dict(reversed(self.spec.items())))[1]["id"], plan["id"])
        confirm = "/api/plans/" + plan["id"] + "/confirm"
        for body in ({"digest": plan["digest"]}, {"digest": plan["digest"], "confirmed": False},
                     {"digest": "0"*64, "confirmed": True}):
            self.assertEqual(self.request(confirm, body)[0], 400)
        ack = dict(confirmed=True, digest=plan["digest"])
        self.assertEqual(self.request(confirm, ack, origin=False)[0], 403)
        self.assertEqual(self.request("/api/plans/" + plan["id"])[1]["state"], "pending")
        for _ in range(2):
            status, reply = self.request(confirm, ack)
            self.assertEqual((status, reply["state"], reply["job_id"]), (200, "confirmed", None))
        self.assertEqual(self.request("/api/plans")[1]["plans"], [reply])

    def test_dispatch_requires_profile_source_and_validated_resources(self):
        invalid = [dict(workflow="synthetic-v100"), dict(workflow="vasp-relaxation"),
                   dict(cpus=True), dict(minutes=0), dict(gpus=9), dict(shell="forbidden")]
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                self.assertEqual(self.request("/api/plans", self.spec | overrides)[0], 400)
        self.assertEqual(self.request("/api/plans")[1], {"plans": [], "synthetic_submission": False})
        self.http.synthetic_submission = True
        name, data, options, _ = md_case()
        research = self.http.workspace.analyze("md", name, data, options, "research")
        synthetic = self.spec | dict(workflow="synthetic-v100")
        for overrides in [dict(run_id=research["id"]), dict(minutes=3), dict(cpus=4), dict(gpus=0)]:
            self.assertEqual(self.request("/api/plans", synthetic | overrides)[0], 400)
