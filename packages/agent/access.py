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
        if not _ID.fullmatch(username) or not isinstance(entry, dict) or entry.keys() != {
            "password_hash", "projects"
        }:
            raise ValueError("Invalid access policy user")
        verifier = entry["password_hash"]
        match = _VERIFIER.fullmatch(verifier) if isinstance(verifier, str) else None
        projects = entry["projects"]
        if match is None or not isinstance(projects, dict) or any(
            not _ID.fullmatch(project) or not isinstance(role, str) or role not in _ROLES
            for project, role in projects.items()
        ):
            raise ValueError("Invalid password verifier or project role")
        users[username] = (bytes.fromhex(match[1]), bytes.fromhex(match[2]), projects)
    return users, before


@dataclass(frozen=True)
class _Session:
    actor: str
    expires: float


class AccessPolicy:
    """Authenticate users and issue expiring sessions scoped to this instance."""

    def __init__(self, path):
        self._path = Path(path).absolute()
        self._users, self._version = _read_policy(self._path)
        self._disabled = False
        self._lock = Lock()
        self._hash_slots = BoundedSemaphore(_HASH_SLOTS)
        self._attempts = deque()
        self._by_user = {}
        self._sessions = {}
        self._dummy_salt = secrets.token_bytes(16)
        self._dummy_hash = secrets.token_bytes(32)

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
        while self._sessions:
            token, oldest = next(iter(self._sessions.items()))
            if oldest.expires > now:
                break
            del self._sessions[token]

    def login(self, username, password):
        if not isinstance(username, str) or len(username) > 96 or not _ID.fullmatch(username):
            return None
        try:
            encoded = _password_bytes(password)
        except ValueError:
            return None
        with self._lock:
            if not self._current():
                return None
            self._reserve_attempt(username, monotonic())
        try:
            user = self._users.get(username)
            salt, verifier = user[:2] if user is not None else (self._dummy_salt, self._dummy_hash)
            valid = secrets.compare_digest(_derive(encoded, salt), verifier)
        finally:
            self._hash_slots.release()
        if not valid or user is None:
            return None
        with self._lock:
            if not self._current():
                return None
            now = monotonic()
            self._prune_sessions(now)
            if len(self._sessions) >= _SESSION_LIMIT:
                del self._sessions[next(iter(self._sessions))]
            token = "sess-" + secrets.token_urlsafe(32)
            self._sessions[token] = _Session(username, now + _SESSION_TTL)
            return token

    def actor(self, token):
        if not isinstance(token, str) or not _TOKEN.fullmatch(token):
            return None
        with self._lock:
            if not self._current():
                return None
            self._prune_sessions(monotonic())
            session = self._sessions.get(token)
            return session.actor if session else None

    def logout(self, token):
        if isinstance(token, str):
            with self._lock:
                self._sessions.pop(token, None)

    def projects(self, actor):
        """Return a detached role mapping for a previously authenticated actor."""
        if not isinstance(actor, str):
            return {}
        with self._lock:
            user = self._users.get(actor) if self._current() else None
            return dict(user[2]) if user is not None else {}


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
