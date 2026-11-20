"""Focused tests for the optional Zeus identity boundary."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from apps.server import make_server
from packages.agent.access import AccessPolicy, IdentityUnavailable


PHONE = "18148024740"
SUBJECT = "user-zeus-7"
PROJECTS = {"alpha": "analyst", "readonly": "viewer"}


class FakeZeus:
    def __init__(self, result=(SUBJECT, "remote-token")):
        self.result = result
        self.session = SUBJECT
        self.login_calls = []
        self.session_calls = []
        self.logout_calls = []
        self.closed = False
        self.login_error = None
        self.session_error = None
        self.logout_error = None

    def login(self, username, password):
        self.login_calls.append((username, password))
        if self.login_error:
            raise self.login_error
        return self.result

    def session_subject(self, bearer):
        self.session_calls.append(bearer)
        if self.session_error:
            raise self.session_error
        return self.session

    def logout(self, bearer):
        self.logout_calls.append(bearer)
        if self.logout_error:
            raise self.logout_error

    def close(self):
        self.closed = True


class ZeusAccessTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.policy_path = self.root / "policy.json"
        self.policy_path.write_text(json.dumps({"users": {
            PHONE: {"zeus_subject": SUBJECT, "projects": PROJECTS},
        }}), encoding="utf-8")
        self.policy_path.chmod(0o600)

    def test_phone_grant_delegates_credentials_and_preserves_roles(self):
        broker = FakeZeus()
        access = AccessPolicy(self.policy_path, zeus_auth=broker)
        token = access.login(PHONE, "browser-password")

        self.assertRegex(token, r"^sess-[A-Za-z0-9_-]{43}$")
        self.assertEqual(broker.login_calls, [(PHONE, "browser-password")])
        self.assertEqual(access.actor(token), PHONE)
        self.assertEqual(broker.session_calls, ["remote-token"])
        self.assertEqual(access.projects(PHONE), PROJECTS)
        user = access._users[PHONE]
        self.assertIsNone(user.password_salt)
        self.assertIsNone(user.password_verifier)

        access.logout(token)
        self.assertEqual(broker.logout_calls, ["remote-token"])
        access.close()
        self.assertTrue(broker.closed)

    def test_subject_mismatch_is_rejected_and_never_claims_a_local_account(self):
        broker = FakeZeus(result=("different-subject", "remote-token"))
        access = AccessPolicy(self.policy_path, zeus_auth=broker)

        self.assertIsNone(access.login(PHONE, "browser-password"))
        self.assertEqual(broker.login_calls, [(PHONE, "browser-password")])
        self.assertEqual(broker.logout_calls, ["remote-token"])
        self.assertEqual(access.projects(SUBJECT), {})

    def test_revoked_session_is_removed_and_unavailable_is_not_local_fallback(self):
        broker = FakeZeus()
        access = AccessPolicy(self.policy_path, zeus_auth=broker)
        token = access.login(PHONE, "browser-password")
        broker.session = None
        self.assertIsNone(access.actor(token))
        self.assertIsNone(access.actor(token))

        broker.login_error = IdentityUnavailable("down")
        with self.assertRaises(IdentityUnavailable):
            access.login(PHONE, "browser-password")

        no_broker = AccessPolicy(self.policy_path)
        with self.assertRaises(IdentityUnavailable):
            no_broker.login(PHONE, "browser-password")


class ZeusServerAvailabilityTests(unittest.TestCase):
    def test_identity_unavailable_is_a_503_and_server_closes_broker(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            policy_path = root / "policy.json"
            policy_path.write_text(json.dumps({"users": {
                PHONE: {"zeus_subject": SUBJECT, "projects": PROJECTS},
            }}), encoding="utf-8")
            policy_path.chmod(0o600)
            broker = FakeZeus()
            broker.login_error = IdentityUnavailable("down")
            service = make_server(root / "data", "", "", 0,
                                  access_policy=policy_path,
                                  audit_log=root / "audit.jsonl",
                                  backup_root=root / "archives",
                                  zeus_auth=broker)
            thread = Thread(target=service.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{service.server_port}"
                request = Request(base + "/api/login",
                                  data=json.dumps({"username": PHONE,
                                                   "password": "browser-password"}).encode(),
                                  headers={"Host": f"127.0.0.1:{service.server_port}",
                                           "Origin": base,
                                           "Content-Type": "application/json"})
                with self.assertRaises(HTTPError) as raised:
                    build_opener(ProxyHandler({})).open(request, timeout=5)
                self.assertEqual(raised.exception.code, 503)
                self.assertIn("身份服务", raised.exception.read().decode("utf-8"))
            finally:
                service.shutdown()
                service.server_close()
            self.assertTrue(broker.closed)


if __name__ == "__main__":
    unittest.main()
