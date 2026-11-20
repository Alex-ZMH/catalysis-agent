"""Private project access policy, process-local sessions, and durable audit events."""
import argparse
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import warnings
from threading import BoundedSemaphore, Lock
from time import monotonic
from packages.agent.zeus_identity import IdentityUnavailable


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}")
_ROLES = {"viewer", "analyst", "admin"}
_ITERATIONS = 600_000
_VERIFIER = re.compile(rf"pbkdf2_sha256\${_ITERATIONS}\$([0-9a-f]{{32}})\$([0-9a-f]{{64}})")
_TOKEN = re.compile(r"sess-[A-Za-z0-9_-]{43}")
_POLICY_LIMIT = 1024 * 1024
_PASSWORD_LIMIT = 1024
_LOGIN_WINDOW = 60
_ACCOUNT_LIMIT = 5
_GLOBAL_LIMIT = 30
_HASH_SLOTS = 4
_SESSION_TTL = 8 * 60 * 60
_SESSION_LIMIT = 1024


class RateLimitError(RuntimeError):
    """The caller may retry authentication later."""


_PHONE = re.compile(r"(?:\+[1-9][0-9]{7,14}|[1-9][0-9]{7,14})")


def _password_bytes(password):
    if not isinstance(password, str) or not 0 < len(password) <= _PASSWORD_LIMIT:
        raise ValueError("Invalid password length")
    encoded = password.encode("utf-8")
    if len(encoded) > _PASSWORD_LIMIT:
        raise ValueError("Invalid password length")
    return encoded


def _derive(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password, salt, _ITERATIONS)


def hash_password(password):
    """Create a salted verifier using the format accepted by AccessPolicy."""
    encoded = _password_bytes(password)
    salt = secrets.token_bytes(16)
    return f"pbkdf2_sha256${_ITERATIONS}${salt.hex()}${_derive(encoded, salt).hex()}"


@contextmanager
def _parent(path):
    """Open each directory relative to an already-open parent without following links."""
    if ".." in path.parts or path == path.parent:
        raise ValueError("Invalid private file path")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(path.anchor, flags)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        yield directory, path.name
    finally:
        os.close(directory)


def _private(fd):
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & ~0o600):
        raise ValueError("Expected a private, owner-only regular file")
    return info


def _fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_ctime_ns, info.st_mtime_ns, info.st_size)


def _unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("Duplicate JSON key")
        obj[key] = value
    return obj


def _read_policy(path):
    with _parent(path) as (directory, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            before = _fingerprint(_private(fd))
            raw = stream.read(_POLICY_LIMIT + 1)
            after = _fingerprint(_private(fd))
    if len(raw) > _POLICY_LIMIT or before != after:
        raise ValueError("Policy is too large or changed during reading")
    try:
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
    except (ValueError, RecursionError) as error:
        raise ValueError("Invalid access policy JSON") from error
    if (not isinstance(document, dict) or document.keys() != {"users"}
            or not isinstance(document["users"], dict)):
        raise ValueError("Expected an access policy with a users object")
    users = {}
    for username, entry in document["users"].items():
        if (not isinstance(username, str) or not _ID.fullmatch(username)
                or not isinstance(entry, dict)):
            raise ValueError("Invalid access policy user")
        projects = entry.get("projects")
        if (not isinstance(projects, dict) or any(
                not _ID.fullmatch(project) or not isinstance(role, str) or role not in _ROLES
                for project, role in projects.items())):
            raise ValueError("Invalid project role")
        if entry.keys() == {"password_hash", "projects"}:
            verifier = entry["password_hash"]
            match = _VERIFIER.fullmatch(verifier) if isinstance(verifier, str) else None
            if match is None:
                raise ValueError("Invalid password verifier")
            users[username] = _User(projects=projects,
                                     password_salt=bytes.fromhex(match[1]),
                                     password_verifier=bytes.fromhex(match[2]))
        elif entry.keys() == {"zeus_subject", "projects"}:
            # A Zeus grant is deliberately explicit and must be keyed by the
            # account's phone number.  In particular, a stable subject alone
            # never creates or claims a local account.
            subject = entry["zeus_subject"]
            if (not _PHONE.fullmatch(username) or not isinstance(subject, str)
                    or not _ID.fullmatch(subject)):
                raise ValueError("Invalid Zeus identity grant")
            users[username] = _User(projects=projects, zeus_subject=subject)
        else:
            raise ValueError("Invalid access policy user")
    return users, before


@dataclass(frozen=True)
class _User:
    projects: dict
    password_salt: bytes = None
    password_verifier: bytes = None
    zeus_subject: str = None


@dataclass(frozen=True)
class _Session:
    actor: str
    expires: float
    zeus_bearer: str = None
    zeus_subject: str = None


class AccessPolicy:
    """Authenticate users and issue expiring sessions scoped to this instance."""

    def __init__(self, path, zeus_auth=None):
        self._path = Path(path).absolute()
        self._users, self._version = _read_policy(self._path)
        self._zeus = self._resolve_zeus(zeus_auth)
        self._disabled = False
        self._lock = Lock()
        self._hash_slots = BoundedSemaphore(_HASH_SLOTS)
        self._attempts = deque()
        self._by_user = {}
        self._sessions = {}
        self._dummy_salt = secrets.token_bytes(16)
        self._dummy_hash = secrets.token_bytes(32)
        self._closed = False

    @staticmethod
    def _resolve_zeus(zeus_auth):
        if zeus_auth is None or zeus_auth is False:
            return None
        if zeus_auth is not True:
            return zeus_auth
        try:
            from packages.agent.zeus_identity import ZeusIdentity
        except (ImportError, AttributeError) as error:
            raise IdentityUnavailable("Zeus 身份服务不可用。") from error
        try:
            return ZeusIdentity()
        except (ConnectionError, OSError, TimeoutError) as error:
            raise IdentityUnavailable("Zeus 身份服务不可用。") from error

    def _current(self):
        # Called with the lock held. A changed or inaccessible policy revokes
        # all sessions and stays disabled until the service reloads its policy.
        if self._disabled:
            return False
        try:
            with _parent(self._path) as (directory, name):
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    same = _fingerprint(_private(fd)) == self._version
                finally:
                    os.close(fd)
        except (OSError, ValueError):
            same = False
        if not same:
            self._sessions.clear()
            self._disabled = True
        return same

    def _reserve_attempt(self, username, now):
        while self._attempts and self._attempts[0][0] <= now - _LOGIN_WINDOW:
            _, account = self._attempts.popleft()
            remaining = self._by_user[account] - 1
            if remaining:
                self._by_user[account] = remaining
            else:
                del self._by_user[account]
        if len(self._attempts) >= _GLOBAL_LIMIT or self._by_user.get(username, 0) >= _ACCOUNT_LIMIT:
            raise RateLimitError("Too many login attempts")
        if not self._hash_slots.acquire(blocking=False):
            raise RateLimitError("Authentication is busy")
        # The global window bounds storage for both known and unknown names.
        self._attempts.append((now, username))
        self._by_user[username] = self._by_user.get(username, 0) + 1

    def _prune_sessions(self, now):
        # All sessions have the same TTL and are inserted under the lock.
        expired = []
        while self._sessions:
            token, oldest = next(iter(self._sessions.items()))
            if oldest.expires > now:
                break
            del self._sessions[token]
            if oldest.zeus_bearer:
                expired.append(oldest.zeus_bearer)
        return expired

    @staticmethod
    def _identity_call(broker, method, *args):
        try:
            value = getattr(broker, method)(*args)
        except IdentityUnavailable:
            raise
        except (AttributeError, ConnectionError, OSError, TimeoutError) as error:
            raise IdentityUnavailable("Zeus 身份服务暂时不可用。") from error
        return value

    def _broker_logout(self, bearer, *, best_effort=False):
        if not bearer or self._zeus is None:
            return
        try:
            self._identity_call(self._zeus, "logout", bearer)
        except IdentityUnavailable:
            if not best_effort:
                raise

    def _finish_zeus_login(self, username, password, user):
        if self._zeus is None:
            # No local password verifier is accepted for a Zeus grant.  A
            # missing/disabled broker is an availability failure, never a
            # reason to fall back to a password hash or phone-number match.
            raise IdentityUnavailable("Zeus 身份服务未启用。")
        result = self._identity_call(self._zeus, "login", username, password)
        if result is None:
            return None
        if (not isinstance(result, tuple) or len(result) != 2
                or not isinstance(result[0], str) or not isinstance(result[1], str)
                or not result[0] or not result[1]):
            raise IdentityUnavailable("Zeus 身份服务返回了无效会话。")
        subject, bearer = result
        if subject != user.zeus_subject:
            # Do not grant access merely because the phone/password was
            # accepted by an account whose stable subject is different.
            self._broker_logout(bearer, best_effort=True)
            return None
        with self._lock:
            if not self._current():
                current = False
                expired = []
            else:
                current = True
                expired = self._prune_sessions(monotonic())
                if len(self._sessions) >= _SESSION_LIMIT:
                    evicted = self._sessions.pop(next(iter(self._sessions)))
                    if evicted.zeus_bearer:
                        expired.append(evicted.zeus_bearer)
                token = "sess-" + secrets.token_urlsafe(32)
                self._sessions[token] = _Session(
                    username, monotonic() + _SESSION_TTL, bearer, subject)
        for old_bearer in expired:
            self._broker_logout(old_bearer, best_effort=True)
        if not current:
            self._broker_logout(bearer, best_effort=True)
            return None
        return token

    def login(self, username, password):
        if (not isinstance(username, str) or len(username) > 96 or not _ID.fullmatch(username)):
            return None
        try:
            encoded = _password_bytes(password)
        except ValueError:
            return None
        with self._lock:
            if not self._current():
                return None
            self._reserve_attempt(username, monotonic())
            user = self._users.get(username)
        if user is not None and user.zeus_subject is not None:
            # The semaphore is an anti-DoS bound for local PBKDF work.  Do
            # not hold a slot or policy lock while calling the remote broker.
            self._hash_slots.release()
            return self._finish_zeus_login(username, password, user)
        try:
            salt, verifier = ((user.password_salt, user.password_verifier)
                              if user is not None else (self._dummy_salt, self._dummy_hash))
            valid = secrets.compare_digest(_derive(encoded, salt), verifier)
        finally:
            self._hash_slots.release()
        if not valid or user is None:
            return None
        with self._lock:
            if not self._current():
                return None
            now = monotonic()
            expired = self._prune_sessions(now)
            if len(self._sessions) >= _SESSION_LIMIT:
                evicted = self._sessions.pop(next(iter(self._sessions)))
                if evicted.zeus_bearer:
                    expired.append(evicted.zeus_bearer)
            token = "sess-" + secrets.token_urlsafe(32)
            self._sessions[token] = _Session(username, now + _SESSION_TTL)
        for bearer in expired:
            self._broker_logout(bearer, best_effort=True)
        return token

    def actor(self, token):
        if not isinstance(token, str) or not _TOKEN.fullmatch(token):
            return None
        with self._lock:
            if not self._current():
                return None
            expired = self._prune_sessions(monotonic())
            session = self._sessions.get(token)
        for bearer in expired:
            self._broker_logout(bearer, best_effort=True)
        if session is None:
            return None
        if session.zeus_bearer:
            if self._zeus is None:
                raise IdentityUnavailable("Zeus 身份服务未启用。")
            subject = self._identity_call(self._zeus, "session_subject", session.zeus_bearer)
            if subject is not None and not isinstance(subject, str):
                raise IdentityUnavailable("Zeus 身份服务返回了无效会话。")
            if subject != session.zeus_subject:
                with self._lock:
                    if self._sessions.get(token) == session:
                        self._sessions.pop(token, None)
                return None
            # Logout may race with a session check.  Do not let a stale
            # validation resurrect a token removed in the meantime.
            with self._lock:
                return session.actor if self._sessions.get(token) == session else None
        return session.actor

    def logout(self, token):
        if not isinstance(token, str):
            return
        with self._lock:
            expired = self._prune_sessions(monotonic())
            session = self._sessions.pop(token, None)
            if session is not None and session.zeus_bearer:
                expired.append(session.zeus_bearer)
        for bearer in expired:
            self._broker_logout(bearer)

    def close(self):
        """Revoke local sessions and close the optional broker outside the lock."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            sessions = list(self._sessions.values())
            self._sessions.clear()
            broker = self._zeus
        if broker is not None:
            for session in sessions:
                if session.zeus_bearer:
                    self._broker_logout(session.zeus_bearer, best_effort=True)
            close = getattr(broker, "close", None)
            if callable(close):
                try:
                    close()
                except (ConnectionError, OSError, TimeoutError):
                    pass

    def projects(self, actor):
        """Return a detached role mapping for a previously authenticated actor."""
        if not isinstance(actor, str):
            return {}
        with self._lock:
            user = self._users.get(actor) if self._current() else None
            return dict(user.projects) if user is not None else {}


def _audit_value(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Audit field names must be strings")
            normalized = re.sub(r"[^a-z0-9]", "", key.lower())
            if any(word in normalized for word in
                   ("password", "passwd", "passphrase", "token", "cookie", "authorization",
                    "credential", "secret", "verifier")):
                raise ValueError("Credential fields are prohibited in audit events")
            _audit_value(key)
            _audit_value(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _audit_value(item)
    elif isinstance(value, str) and (_TOKEN.search(value) or "pbkdf2_sha256$" in value):
        raise ValueError("Credential values are prohibited in audit events")


class AuditLog:
    """Append already-sanitized events privately, raising on any write error."""

    def __init__(self, path):
        self._path = Path(path).absolute()

    def record(self, event):
        if not isinstance(event, dict):
            raise ValueError("Expected an audit event object")
        _audit_value(event)
        line = (json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                + "\n").encode("utf-8")
        with _parent(self._path) as (directory, name):
            flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
            fd = os.open(name, flags, 0o600, dir_fd=directory)
            try:
                _private(fd)
                fcntl.flock(fd, fcntl.LOCK_EX)
                size = _private(fd).st_size
                if size and os.pread(fd, 1, size - 1) != b"\n":
                    raise ValueError("Audit log has an incomplete final record")
                pending = memoryview(line)
                try:
                    while pending:
                        count = os.write(fd, pending)
                        if count <= 0:
                            raise OSError("Audit write did not advance")
                        pending = pending[count:]
                    os.fsync(fd)
                except OSError:
                    os.ftruncate(fd, size)
                    os.fsync(fd)
                    raise
                os.fsync(directory)
            finally:
                os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate a private access-policy password verifier")
    parser.add_argument("command", choices=["hash-password"])
    parser.parse_args(argv)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            first = getpass.getpass("Password: ")
            repeated = getpass.getpass("Repeat password: ")
    except (EOFError, getpass.GetPassWarning):
        parser.error("An interactive terminal with hidden password input is required")
    if first != repeated:
        parser.error("Passwords do not match")
    try:
        print(hash_password(first))
    except ValueError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
