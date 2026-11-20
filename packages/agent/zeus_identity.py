"""Small, fixed-endpoint identity bridge for the managed workbench.

The workbench is placed under a seccomp egress filter during startup.  The
identity client therefore starts this module as a separate worker *before*
that filter is installed and talks to it over JSON lines on stdin/stdout.  The
worker has no URL or command input: it can only call the three Zeus identity
endpoints declared below.

Only the worker performs network I/O.  The parent process never imports a
network client and exposes the small ``ZeusIdentity`` API used by the server.
Credentials and bearer tokens are deliberately absent from all error values.
"""

import json
from pathlib import Path
import re
import ssl
import subprocess
import sys
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, Request, build_opener
import http.client


AUTH_BASE = "https://agent.mattok.cn/v1/auth"
LOGIN_URL = AUTH_BASE + "/login"
SESSION_URL = AUTH_BASE + "/session"
LOGOUT_URL = AUTH_BASE + "/logout"
_ENDPOINTS = frozenset((LOGIN_URL, SESSION_URL, LOGOUT_URL))

# These are deliberately constants rather than request parameters.  A remote
# caller cannot turn the worker into a general HTTP proxy.
REQUEST_TIMEOUT_SECONDS = 15
MAX_REQUEST_BYTES = 32 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
MAX_IPC_LINE_BYTES = 256 * 1024
MAX_PHONE_BYTES = 32
MAX_PASSWORD_BYTES = 8 * 1024
MAX_BEARER_BYTES = 16 * 1024
MAX_SUBJECT_BYTES = 4 * 1024

_PHONE = re.compile(r"\+[1-9][0-9]{6,14}\Z")


class IdentityUnavailable(RuntimeError):
    """The identity service could not be used for this request.

    The message is intentionally generic.  It must never include a password,
    bearer token, response body, URL supplied by a caller, or exception text
    from the network stack.
    """


_UNAVAILABLE = "身份服务暂时不可用。"


def _is_phone(value):
    if not isinstance(value, str):
        return False
    try:
        return (len(value.encode("utf-8")) <= MAX_PHONE_BYTES
                and _PHONE.fullmatch(value) is not None)
    except UnicodeError:
        return False


def _normalize_phone(value):
    """Accept the caller's domestic form, but send only E.164 to Zeus."""
    if not isinstance(value, str):
        return None
    if re.fullmatch(r"1[3-9][0-9]{9}", value):
        value = "+86" + value
    return value if _is_phone(value) else None


def _is_password(value):
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(value.encode("utf-8")) <= MAX_PASSWORD_BYTES
    except UnicodeError:
        return False


def _is_header_credential(value):
    """Check a value before putting it into an HTTP header."""
    if not isinstance(value, str) or not 0 < len(value) <= MAX_BEARER_BYTES:
        return False
    try:
        value.encode("ascii", "strict")
    except UnicodeEncodeError:
        return False
    return all(0x21 <= ord(char) <= 0x7E for char in value)


def _is_subject(value):
    if not isinstance(value, str) or not 0 < len(value) <= MAX_SUBJECT_BYTES:
        return False
    try:
        return (len(value.encode("utf-8")) <= MAX_SUBJECT_BYTES
                and all(ord(char) >= 0x20 and char not in "\x7f\r\n" for char in value))
    except UnicodeError:
        return False


def _json_bytes(value):
    try:
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise IdentityUnavailable(_UNAVAILABLE) from None
    if len(data) > MAX_REQUEST_BYTES:
        raise IdentityUnavailable(_UNAVAILABLE)
    return data


def _read_limited(stream):
    """Read an HTTP body without allowing an unbounded response."""
    body = stream.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise IdentityUnavailable(_UNAVAILABLE)
    return body


class _RedirectRejected(OSError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers):
        raise _RedirectRejected()


def _build_opener():
    """Build a direct, certificate-verifying HTTPS opener."""
    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    # An empty ProxyHandler prevents environment-controlled proxy redirects or
    # proxy destinations from changing the fixed HTTPS trust boundary.
    return build_opener(
        ProxyHandler({}),
        _NoRedirect(),
        HTTPSHandler(context=context),
    )


class _IdentityHTTP:
    def __init__(self, opener=None):
        self.opener = opener if opener is not None else _build_opener()

    def request(self, method, url, *, body=None, headers=None):
        if url not in _ENDPOINTS:
            raise IdentityUnavailable(_UNAVAILABLE)
        request = Request(url, data=body, headers=headers or {}, method=method)
        try:
            with self.opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return int(response.getcode()), _read_limited(response)
        except HTTPError as error:
            # Authentication failures are meaningful to the caller.  Other
            # HTTP failures are reduced to the generic unavailable state.
            try:
                body = _read_limited(error)
            except (IdentityUnavailable, OSError, ValueError):
                body = b""
            return int(error.code), body
        except (OSError, URLError, TimeoutError, ValueError, UnicodeError,
                http.client.HTTPException):
            raise IdentityUnavailable(_UNAVAILABLE) from None


def _response_object(body):
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeError, ValueError, TypeError):
        raise IdentityUnavailable(_UNAVAILABLE) from None
    if not isinstance(value, dict):
        raise IdentityUnavailable(_UNAVAILABLE)
    return value


def _http_failure(status):
    if status in (401, 403):
        return {"ok": False, "kind": "auth"}
    # 408, 429 and server failures are retryable/unavailable.  Treat every
    # other non-success status as unavailable too; in particular, never turn a
    # malformed or unexpected response into a local session.
    if status < 200 or status >= 300:
        return {"ok": False, "kind": "unavailable"}
    return None


def _worker_dispatch(request, client=None):
    """Handle one private IPC request and return a safe wire response."""
    if not isinstance(request, dict):
        return {"ok": False, "kind": "unavailable"}
    client = client if client is not None else _IdentityHTTP()
    operation = request.get("op")

    try:
        if operation == "login":
            phone = _normalize_phone(request.get("username"))
            password = request.get("password")
            if phone is None or not _is_password(password):
                return {"ok": False, "kind": "auth"}
            status, body = client.request(
                "POST", LOGIN_URL,
                body=_json_bytes({"contact": {"kind": "phone", "value": phone},
                                  "password": password}),
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            failure = _http_failure(status)
            if failure is not None:
                return failure
            response = _response_object(body)
            user = response.get("user")
            subject = user.get("id") if isinstance(user, dict) else None
            bearer = response.get("accessToken")
            if not _is_subject(subject) or not _is_header_credential(bearer):
                return {"ok": False, "kind": "unavailable"}
            return {"ok": True, "subject": subject, "bearer": bearer}

        if operation == "session":
            bearer = request.get("bearer")
            if not _is_header_credential(bearer):
                return {"ok": False, "kind": "auth"}
            status, body = client.request(
                "GET", SESSION_URL,
                headers={"Accept": "application/json", "Authorization": "Bearer " + bearer},
            )
            failure = _http_failure(status)
            if failure is not None:
                return failure
            response = _response_object(body)
            user = response.get("user")
            subject = user.get("id") if isinstance(user, dict) else None
            if not _is_subject(subject):
                return {"ok": False, "kind": "unavailable"}
            return {"ok": True, "subject": subject}

        if operation == "logout":
            bearer = request.get("bearer")
            if not _is_header_credential(bearer):
                return {"ok": False, "kind": "auth"}
            status, _ = client.request(
                "POST", LOGOUT_URL,
                headers={"Accept": "application/json", "Authorization": "Bearer " + bearer},
            )
            failure = _http_failure(status)
            return failure if failure is not None else {"ok": True}

        return {"ok": False, "kind": "unavailable"}
    except IdentityUnavailable:
        return {"ok": False, "kind": "unavailable"}
    except Exception:
        # The worker is a security boundary.  Do not serialize exception text;
        # it may contain request data or a token supplied by a peer.
        return {"ok": False, "kind": "unavailable"}


def _worker_main():
    client = _IdentityHTTP()
    while True:
        line = sys.stdin.readline(MAX_IPC_LINE_BYTES + 1)
        if not line:
            break
        if (not line.endswith("\n")
                or len(line.encode("utf-8")) > MAX_IPC_LINE_BYTES):
            result = {"ok": False, "kind": "unavailable"}
        else:
            try:
                request = json.loads(line[:-1])
            except (UnicodeError, ValueError, TypeError):
                request = None
            result = _worker_dispatch(request, client)
        # Only safe, normalized fields from _worker_dispatch are emitted.
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def _read_ipc_line(stream):
    line = stream.readline(MAX_IPC_LINE_BYTES + 1)
    if (not line.endswith("\n")
            or len(line.encode("utf-8")) > MAX_IPC_LINE_BYTES):
        raise IdentityUnavailable(_UNAVAILABLE)
    return line[:-1]


class ZeusIdentity:
    """Parent-side broker for the fixed Zeus identity service."""

    def __init__(self):
        try:
            self.process = subprocess.Popen(
                [sys.executable, "-I", str(Path(__file__).resolve()), "--worker"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="strict",
                bufsize=1,
                close_fds=True,
                shell=False,
            )
        except (OSError, ValueError, TypeError):
            raise IdentityUnavailable(_UNAVAILABLE) from None
        self._lock = Lock()
        self._closed = False

    def _call(self, request):
        try:
            encoded = _json_bytes(request)
        except IdentityUnavailable:
            raise
        with self._lock:
            if self._closed or self.process.poll() is not None:
                raise IdentityUnavailable(_UNAVAILABLE)
            try:
                self.process.stdin.write(encoded.decode("utf-8") + "\n")
                self.process.stdin.flush()
                line = _read_ipc_line(self.process.stdout)
                result = json.loads(line)
            except (BrokenPipeError, EOFError, OSError, ValueError, TypeError,
                    UnicodeError, IdentityUnavailable):
                raise IdentityUnavailable(_UNAVAILABLE) from None
        if not isinstance(result, dict):
            raise IdentityUnavailable(_UNAVAILABLE)
        return result

    @staticmethod
    def _result_kind(result):
        return result.get("kind") if isinstance(result, dict) else None

    def login(self, username, password):
        """Return ``(subject, bearer)`` or ``None`` for real auth rejection."""
        username = _normalize_phone(username)
        if username is None or not _is_password(password):
            return None
        result = self._call({"op": "login", "username": username, "password": password})
        if result.get("ok") is True:
            subject = result.get("subject")
            bearer = result.get("bearer")
            if _is_subject(subject) and _is_header_credential(bearer):
                return subject, bearer
            raise IdentityUnavailable(_UNAVAILABLE)
        if self._result_kind(result) == "auth":
            return None
        raise IdentityUnavailable(_UNAVAILABLE)

    def session_subject(self, bearer):
        """Return the remote subject or ``None`` for a real 401/403."""
        if not _is_header_credential(bearer):
            return None
        result = self._call({"op": "session", "bearer": bearer})
        if result.get("ok") is True:
            subject = result.get("subject")
            if _is_subject(subject):
                return subject
            raise IdentityUnavailable(_UNAVAILABLE)
        if self._result_kind(result) == "auth":
            return None
        raise IdentityUnavailable(_UNAVAILABLE)

    def logout(self, bearer):
        """Revoke a remote bearer; invalid credentials are already logged out."""
        if not _is_header_credential(bearer):
            return None
        result = self._call({"op": "logout", "bearer": bearer})
        if result.get("ok") is True or self._result_kind(result) == "auth":
            return None
        raise IdentityUnavailable(_UNAVAILABLE)

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            process = self.process
            try:
                if process.stdin is not None:
                    process.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=3)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                try:
                    process.kill()
                    process.wait(timeout=3)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
            for stream in (process.stdout, process.stdin):
                try:
                    if stream is not None:
                        stream.close()
                except (OSError, ValueError):
                    pass


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--worker":
        _worker_main()
    else:
        raise SystemExit(2)
