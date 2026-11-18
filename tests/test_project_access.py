"""Test private policy validation, session lifecycle, and audit durability."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from threading import Barrier, Event
import unittest
from unittest.mock import patch

from packages.agent import access


PASSWORD = "example passphrase é"
PROJECTS = {"p1": "admin", "p2": "viewer", "p3": "analyst"}


class AccessPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.verifier = access.hash_password(PASSWORD)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.path = self.directory / "access.json"
        self.policy = {"users": {"alice": {"password_hash": self.verifier, "projects": PROJECTS}}}
        self.write_policy(self.policy)

    def write_policy(self, document):
        self.path.write_text(json.dumps(document), encoding="utf-8")
        self.path.chmod(0o600)

    def test_password_helper_and_project_roles(self):
        other = access.hash_password(PASSWORD)
        self.assertNotEqual(other, self.verifier)
        self.assertRegex(other, r"^pbkdf2_sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$")
        out = io.StringIO()
        with patch.object(access.getpass, "getpass", side_effect=[PASSWORD, PASSWORD]), redirect_stdout(out):
            self.assertEqual(access.main(["hash-password"]), 0)
        self.policy["users"]["alice"]["password_hash"] = out.getvalue().strip()
        self.write_policy(self.policy)
        policy = access.AccessPolicy(self.path)
        self.assertIsNone(policy.login("alice", "wrong"))
        self.assertIsNone(policy.login("unknown", PASSWORD))
        self.assertIsNone(policy.login("alice", "x" * 1025))
        token = policy.login("alice", PASSWORD)
        self.assertRegex(token, r"^sess-[A-Za-z0-9_-]{43}$")
        self.assertEqual(policy.actor(token), "alice")
        projects = policy.projects(policy.actor(token))
        self.assertEqual(projects, PROJECTS)
        projects["outside"] = "admin"
        self.assertEqual(policy.projects("alice"), PROJECTS)
        self.assertEqual(policy.projects("unknown"), {})

    def test_expiration_logout_restart_and_config_revocation(self):
        with patch.object(access, "monotonic", return_value=100) as clock:
            policy = access.AccessPolicy(self.path)
            first = policy.login("alice", PASSWORD)
            second = policy.login("alice", PASSWORD)
            self.assertNotEqual(first, second)
            policy.logout(first)
            policy.logout(first)
            self.assertIsNone(policy.actor(first))
            self.assertEqual(policy.actor(second), "alice")
            self.assertIsNone(access.AccessPolicy(self.path).actor(second))
            clock.return_value += access._SESSION_TTL
            self.assertIsNone(policy.actor(second))
            third = policy.login("alice", PASSWORD)
            replacement = self.directory / "replacement"
            replacement.write_bytes(self.path.read_bytes())
            replacement.chmod(0o600)
            replacement.replace(self.path)
            self.assertIsNone(policy.actor(third))
            self.assertEqual(policy.projects("alice"), {})
            self.assertIsNone(policy.login("alice", PASSWORD))
            self.assertIsNotNone(access.AccessPolicy(self.path).login("alice", PASSWORD))

    def test_private_strict_policy_format(self):
        documents = [
            "{}",
            '{"users":{},"users":{}}',
            '{"users":{},"extra":true}',
            json.dumps({"users": {"bad/user": self.policy["users"]["alice"]}}),
            json.dumps({"users": {"alice": {"password_hash": self.verifier, "projects": {"p": "owner"}}}}),
            json.dumps({"users": {"alice": {"password_hash": self.verifier, "projects": {"../p": "admin"}}}}),
            json.dumps({"users": {"alice": {"password_hash": "password", "projects": PROJECTS}}}),
            json.dumps({"users": {"alice": {"password_hash": self.verifier, "projects": {"p": []}}}}),
        ]
        for document in documents:
            with self.subTest(document=document):
                self.path.write_text(document, encoding="utf-8")
                with self.assertRaises(ValueError):
                    access.AccessPolicy(self.path)
        self.write_policy(self.policy)
        self.path.chmod(0o640)
        with self.assertRaises(ValueError):
            access.AccessPolicy(self.path)
        self.path.chmod(0o600)
        alias = self.directory / "alias"
        os.link(self.path, alias)
        with self.assertRaises(ValueError):
            access.AccessPolicy(self.path)
        alias.unlink()
        alias.symlink_to(self.path)
        with self.assertRaises(OSError):
            access.AccessPolicy(alias)
        linked_parent = self.directory / "linked"
        linked_parent.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(OSError):
            access.AccessPolicy(linked_parent / self.path.name)

    def test_rate_limits_known_unknown_and_global_attempts(self):
        policy = access.AccessPolicy(self.path)
        with patch.object(access, "_derive", return_value=b"\x00" * 32) as derive:
            with patch.object(access, "monotonic", return_value=100) as clock:
                for username in ("alice", "unknown"):
                    for _ in range(access._ACCOUNT_LIMIT):
                        self.assertIsNone(policy.login(username, "bad"))
                    with self.assertRaises(access.RateLimitError):
                        policy.login(username, "bad")
                for index in range(access._GLOBAL_LIMIT - 2 * access._ACCOUNT_LIMIT):
                    self.assertIsNone(policy.login(f"user-{index}", "bad"))
                with self.assertRaises(access.RateLimitError):
                    policy.login("another", "bad")
                self.assertEqual(derive.call_count, access._GLOBAL_LIMIT)
                clock.return_value += access._LOGIN_WINDOW
                self.assertIsNone(policy.login("alice", "bad"))

    def test_concurrent_hashing_is_bounded(self):
        policy = access.AccessPolicy(self.path)
        entered = Barrier(access._HASH_SLOTS + 1)
        release = Event()

        def hold_hash(*_):
            entered.wait(timeout=5)
            if not release.wait(5):
                raise TimeoutError("Test did not release password checks")
            return b"\x00" * 32

        with patch.object(access, "_derive", side_effect=hold_hash):
            with ThreadPoolExecutor(max_workers=access._HASH_SLOTS) as pool:
                jobs = [pool.submit(policy.login, f"user-{i}", "bad")
                        for i in range(access._HASH_SLOTS)]
                try:
                    entered.wait(timeout=5)
                    with self.assertRaisesRegex(access.RateLimitError, "busy"):
                        policy.login("alice", PASSWORD)
                finally:
                    release.set()
                self.assertEqual([job.result(timeout=5) for job in jobs], [None] * len(jobs))


class AuditLogTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.path = self.directory / "audit.jsonl"
        self.audit = access.AuditLog(self.path)

    def test_durable_private_concurrent_appends(self):
        events = [{"actor": "alice", "sequence": n, "project": "p1"} for n in range(30)]
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(self.audit.record, events))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        actual = [json.loads(line) for line in self.path.read_text().splitlines()]
        self.assertEqual(sorted(actual, key=lambda event: event["sequence"]), events)

    def test_audit_rejects_credentials_before_any_write(self):
        verifier = access.hash_password(PASSWORD)
        for event in (
            {"password_hash": verifier},
            {"nested": [{"Authorization": "Bearer example"}]},
            {"details": "failed for sess-" + "a" * 43},
            {"details": f"failed for {verifier}"},
        ):
            with self.subTest(keys=list(event)), self.assertRaises(ValueError):
                self.audit.record(event)
        self.assertFalse(self.path.exists())

    def test_audit_refuses_linked_or_nonprivate_paths(self):
        original = self.directory / "original"
        original.write_text("preserved\n")
        original.chmod(0o600)
        self.path.symlink_to(original)
        with self.assertRaises(OSError):
            self.audit.record({"event": "login"})
        self.path.unlink()
        os.link(original, self.path)
        with self.assertRaises(ValueError):
            self.audit.record({"event": "login"})
        self.path.unlink()
        self.path.write_bytes(b"")
        self.path.chmod(0o664)
        with self.assertRaises(ValueError):
            self.audit.record({"event": "login"})
        linked_parent = self.directory / "linked"
        linked_parent.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(OSError):
            access.AuditLog(linked_parent / "other.jsonl").record({"event": "login"})
        self.assertEqual(original.read_text(), "preserved\n")
        self.assertEqual(self.path.read_bytes(), b"")

    def test_failed_append_propagates_and_rolls_back_partial_line(self):
        self.audit.record({"event": "existing"})
        previous = self.path.read_bytes()
        write = os.write
        def partial(fd, data):
            return write(fd, data[:4])
        with patch.object(access.os, "write", side_effect=_partial_then_fail(partial)):
            with self.assertRaisesRegex(OSError, "simulated disk error"):
                self.audit.record({"event": "new"})
        self.assertEqual(self.path.read_bytes(), previous)
        self.audit.record({"event": "retry"})
        self.assertEqual(len(self.path.read_bytes().splitlines()), 2)

    def test_existing_incomplete_line_fails_closed(self):
        self.path.write_bytes(b'{"event":')
        self.path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.audit.record({"event": "new"})
        self.assertEqual(self.path.read_bytes(), b'{"event":')


def _partial_then_fail(write_partial):
    calls = 0

    def write(fd, data):
        nonlocal calls
        calls += 1
        if calls == 1:
            return write_partial(fd, data)
        raise OSError("simulated disk error")

    return write
