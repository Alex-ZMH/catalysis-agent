"""Local contract tests for the fixed Zeus identity bridge."""

import io
import json
from unittest import TestCase
from unittest.mock import patch
import subprocess
import sys

from packages.agent import zeus_identity as identity


class _Response:
    def __init__(self, status, body=b""):
        self.status = status
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def getcode(self):
        return self.status

    def read(self, size=-1):
        if size < 0:
            body, self.body = self.body, b""
            return body
        body, self.body = self.body[:size], self.body[size:]
        return body


class _Opener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []
        self.timeouts = []

    def open(self, request, timeout):
        self.requests.append(request)
        self.timeouts.append(timeout)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class _Client:
    def __init__(self, *results):
        self.results = list(results)
        self.requests = []

    def request(self, method, url, *, body=None, headers=None):
        self.requests.append((method, url, body, headers or {}))
        result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


class _Pipe:
    def __init__(self, value=""):
        self.value = value
        self.closed = False

    def write(self, value):
        self.value += value
        return len(value)

    def flush(self):
        return None

    def close(self):
        self.closed = True

    def read(self, size=-1):
        if size < 0:
            value, self.value = self.value, ""
            return value
        value, self.value = self.value[:size], self.value[size:]
        return value

    def readline(self, size=-1):
        if "\n" not in self.value:
            value, self.value = self.value, ""
            return value[:size] if size >= 0 else value
        end = self.value.index("\n") + 1
        if size >= 0:
            end = min(end, size)
        value, self.value = self.value[:end], self.value[end:]
        return value


class _Process:
    def __init__(self, *responses):
        self.stdin = _Pipe()
        self.stdout = _Pipe("".join(json.dumps(item) + "\n" for item in responses))
        self.terminated = False
        self.killed = False
        self.waited = False

    def poll(self):
        return None

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        self.waited = True
        return 0


class ZeusIdentityHttpContract(TestCase):
    def test_login_uses_fixed_json_contract_and_extracts_subject_and_token(self):
        opener = _Opener(_Response(
            200, b'{"user":{"id":"zeus-user-7"},"accessToken":"remote-token"}',
        ))
        client = identity._IdentityHTTP(opener)
        result = identity._worker_dispatch({
            "op": "login", "username": "+8613800138000", "password": "correct horse",
        }, client)

        self.assertEqual(result, {"ok": True, "subject": "zeus-user-7", "bearer": "remote-token"})
        request = opener.requests[0]
        self.assertEqual(request.full_url, identity.LOGIN_URL)
        self.assertEqual(request.method, "POST")
        self.assertEqual(json.loads(request.data.decode()), {
            "contact": {"kind": "phone", "value": "+8613800138000"},
            "password": "correct horse",
        })
        self.assertEqual(opener.timeouts, [identity.REQUEST_TIMEOUT_SECONDS])

    def test_session_and_logout_send_bearer_to_fixed_endpoints(self):
        opener = _Opener(
            _Response(200, b'{"user":{"id":"zeus-user-7"}}'),
            _Response(204),
        )
        client = identity._IdentityHTTP(opener)
        token = "remote-token"

        self.assertEqual(identity._worker_dispatch({"op": "session", "bearer": token}, client),
                         {"ok": True, "subject": "zeus-user-7"})
        self.assertEqual(identity._worker_dispatch({"op": "logout", "bearer": token}, client),
                         {"ok": True})
        self.assertEqual(opener.requests[0].full_url, identity.SESSION_URL)
        self.assertEqual(opener.requests[0].method, "GET")
        self.assertEqual(opener.requests[0].headers["Authorization"], "Bearer " + token)
        self.assertEqual(opener.requests[1].full_url, identity.LOGOUT_URL)
        self.assertEqual(opener.requests[1].method, "POST")
        self.assertEqual(opener.requests[1].headers["Authorization"], "Bearer " + token)

    def test_real_auth_rejection_is_distinct_from_temporary_unavailability(self):
        for status in (401, 403):
            client = _Client((status, b'{"accessToken":"must-not-escape"}'))
            self.assertEqual(identity._worker_dispatch({
                "op": "login", "username": "+8613800138000", "password": "secret",
            }, client), {"ok": False, "kind": "auth"})

        client = _Client((429, b'{"accessToken":"must-not-escape"}'))
        self.assertEqual(identity._worker_dispatch({
            "op": "login", "username": "+8613800138000", "password": "secret",
        }, client), {"ok": False, "kind": "unavailable"})

    def test_tls_verification_and_no_redirect_are_configured(self):
        opener = identity._build_opener()
        https = next(handler for handler in opener.handlers
                      if isinstance(handler, identity.HTTPSHandler))
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode, identity.ssl.CERT_REQUIRED)
        self.assertTrue(any(isinstance(handler, identity._NoRedirect)
                            for handler in opener.handlers))
        with self.assertRaises(identity._RedirectRejected):
            identity._NoRedirect().redirect_request(None, None, 302, "redirect", {})

    def test_arbitrary_endpoint_is_rejected(self):
        with self.assertRaises(identity.IdentityUnavailable):
            identity._IdentityHTTP(_Opener()).request("GET", "https://example.invalid/")

    def test_oversized_body_and_malformed_success_never_make_a_token(self):
        large = _Opener(_Response(200, b"x" * (identity.MAX_RESPONSE_BYTES + 1)))
        self.assertEqual(identity._worker_dispatch({
            "op": "login", "username": "+8613800138000", "password": "secret",
        }, identity._IdentityHTTP(large)), {"ok": False, "kind": "unavailable"})

        missing_token = _Client((200, b'{"user":{"id":"zeus-user-7"}}'))
        self.assertEqual(identity._worker_dispatch({
            "op": "login", "username": "+8613800138000", "password": "secret",
        }, missing_token), {"ok": False, "kind": "unavailable"})


class ZeusIdentityBrokerContract(TestCase):
    def test_parent_starts_fixed_isolated_worker_and_returns_success(self):
        process = _Process({"ok": True, "subject": "zeus-user-7", "bearer": "remote-token"})
        with patch.object(identity.subprocess, "Popen", return_value=process) as popen:
            broker = identity.ZeusIdentity()
            self.addCleanup(broker.close)
            self.assertEqual(broker.login("13800138000", "secret"),
                             ("zeus-user-7", "remote-token"))

        command = popen.call_args.args[0]
        self.assertEqual(command[:2], [sys.executable, "-I"])
        self.assertEqual(command[-1], "--worker")
        self.assertEqual(popen.call_args.kwargs["stdin"], subprocess.PIPE)
        self.assertEqual(popen.call_args.kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertFalse(popen.call_args.kwargs["shell"])
        sent = json.loads(process.stdin.value)
        self.assertEqual(sent["op"], "login")
        self.assertEqual(sent["username"], "+8613800138000")
        self.assertNotIn("remote-token", str(sent))

    def test_auth_failure_returns_none_and_unavailable_never_returns_local_token(self):
        rejected = _Process({"ok": False, "kind": "auth", "bearer": "forged-local-token"})
        with patch.object(identity.subprocess, "Popen", return_value=rejected):
            broker = identity.ZeusIdentity()
            self.addCleanup(broker.close)
            self.assertIsNone(broker.login("+8613800138000", "secret"))

        unavailable = _Process({"ok": False, "kind": "unavailable", "bearer": "forged-local-token",
                                "error": "remote-token"})
        with patch.object(identity.subprocess, "Popen", return_value=unavailable):
            broker = identity.ZeusIdentity()
            self.addCleanup(broker.close)
            with self.assertRaises(identity.IdentityUnavailable) as raised:
                broker.login("+8613800138000", "secret")
            self.assertNotIn("remote-token", str(raised.exception))
            self.assertNotIn("forged-local-token", str(raised.exception))

    def test_session_logout_and_close_are_pipe_operations(self):
        process = _Process(
            {"ok": True, "subject": "zeus-user-7"},
            {"ok": True},
        )
        with patch.object(identity.subprocess, "Popen", return_value=process):
            broker = identity.ZeusIdentity()
            self.assertEqual(broker.session_subject("remote-token"), "zeus-user-7")
            self.assertIsNone(broker.logout("remote-token"))
            broker.close()
            broker.close()
        lines = [json.loads(line) for line in process.stdin.value.splitlines()]
        self.assertEqual(lines, [
            {"op": "session", "bearer": "remote-token"},
            {"op": "logout", "bearer": "remote-token"},
        ])
        self.assertTrue(process.terminated)
        self.assertTrue(process.waited)

    def test_invalid_phone_is_not_forwarded(self):
        process = _Process()
        with patch.object(identity.subprocess, "Popen", return_value=process):
            broker = identity.ZeusIdentity()
            self.addCleanup(broker.close)
            self.assertIsNone(broker.login("not-a-phone", "secret"))
        self.assertEqual(process.stdin.value, "")


if __name__ == "__main__":
    import unittest

    unittest.main()
