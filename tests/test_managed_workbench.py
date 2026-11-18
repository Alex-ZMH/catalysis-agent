"""Managed HTTP surface scopes both identity and authorization per request."""
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from apps.server import make_server


@unittest.skipUnless(sys.platform == "linux", "Managed mode is deployed on Linux")
class ManagedWorkbench(unittest.TestCase):
    def setUp(self):
        from packages.agent.access import hash_password

        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.data = root / "data"
        self.policy = root / "policy.json"
        self.audit = root / "audit.jsonl"
        self.policy.touch(mode=0o600)
        self.policy.write_text(json.dumps({"users": {
            "actor": {"password_hash": hash_password("local-synthetic-password"),
                      "projects": {"readonly": "viewer", "lab": "analyst"}},
        }}))
        self.service = make_server(self.data, "", "", 0, access_policy=self.policy,
                                   audit_log=self.audit, backup_root=root / "archives")
        self.addCleanup(self.service.server_close)
        thread = Thread(target=self.service.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.service.shutdown)
        self.base = f"http://127.0.0.1:{self.service.server_port}"
        self.http = build_opener(ProxyHandler({}))
        self.token = None
        status, self.login_id, self.token = self.send("/api/login", {
            "username": "actor", "password": "local-synthetic-password",
        })
        self.assertEqual(status, 200)

    def send(self, path, body=None):
        headers = {"X-Authenticated-User": "forged", "Content-Type": "application/json"}
        if self.token:
            headers["Cookie"] = self.token.split(";", 1)[0]
        if body is not None:
            headers["Origin"] = self.base
        req = Request(self.base + path, headers=headers,
                      data=None if body is None else json.dumps(body).encode())
        try:
            response = self.http.open(req, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers.get("X-Request-ID"), response.headers.get("Set-Cookie")

    def test_scope_roles_and_legacy_guard(self):
        checks = [
            ("/api/projects/readonly/runs", None, 200, "readonly", "project.runs.list"),
            ("/api/projects/readonly/runs", {}, 403, "readonly", "project.run.create"),
            ("/api/projects/lab/backups", None, 403, "lab", "project.backups.list"),
            ("/api/projects/their-lab/runs", None, 403, "their-lab", "project.runs.list"),
            ("/api/runs", None, 403, None, "project.unscoped"),
        ]
        observed = {}
        for path, body, expected, project, action in checks:
            status, request_id, _ = self.send(path, body)
            self.assertEqual(status, expected)
            observed[request_id] = (project, action, status)
        logged = {event["request_id"]: event for event in map(json.loads, self.audit.read_text().splitlines())}
        self.assertEqual(logged[self.login_id]["actor"], "actor")
        for request_id, expected in observed.items():
            event = logged[request_id]
            self.assertEqual(event["actor"], "actor")
            self.assertEqual((event["project"], event["action"], event["status"]), expected)
        self.assertNotIn("local-synthetic-password", self.audit.read_text())
        self.assertNotIn(self.token.split(";", 1)[0], self.audit.read_text())
        self.assertFalse((self.data / "projects" / "their-lab").exists())
        with self.assertRaisesRegex(ValueError, "requires managed"):
            make_server(self.data, "lab", "local", 0)

    def test_unavailable_audit_blocks_private_response(self):
        self.audit.chmod(0o644)
        self.assertEqual(self.send("/api/projects/readonly/runs")[0], 503)
