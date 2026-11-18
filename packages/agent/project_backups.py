"""Read-only archive catalog for the operator-authorized application boundary.

Admin placement: use an existing A7 backup and the archive_sha256 printed by
the backup command. Under the service account, create the catalog root and
the project directory with mode 0700. Copy the ZIP to a private temporary file
in that project directory (mode 0600), then rename it to <archive_sha256>.zip
without replacing any existing entry. Publish only completed archives, keep
their contents immutable, and use a copy rather than a symlink or hard link.
Keep the catalog separate from the live workspace. The caller authorizes
operator access before calling this module.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import stat
import zipfile
import zlib

from packages.agent.backup import _SHA256, _fingerprint, _project_name, _read_manifest, _transfer


_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
_UNAVAILABLE = (OSError, ValueError, zipfile.BadZipFile, EOFError, RuntimeError, OverflowError, zlib.error)


def _private(info):
    return info.st_uid == os.geteuid() and not info.st_mode & 0o077


class ProjectBackups:
    def __init__(self, root):
        self._root = Path(root).absolute()
        if ".." in self._root.parts:
            raise ValueError("Invalid archive catalog root")

    @contextmanager
    def _project(self, project):
        # Walk from the filesystem root with descriptor-relative opens. Ancestor
        # symlinks and replacements cannot redirect a later open by pathname.
        fd = os.open(self._root.anchor, _DIRECTORY_FLAGS)
        try:
            for part in self._root.parts[1:]:
                child = os.open(part, _DIRECTORY_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
            if not _private(os.fstat(fd)):
                raise PermissionError("Archive catalog is unavailable")
            project_fd = os.open(project, _DIRECTORY_FLAGS, dir_fd=fd)
            try:
                if not _private(os.fstat(project_fd)):
                    raise PermissionError("Archive catalog is unavailable")
                yield project_fd
            finally:
                os.close(project_fd)
        finally:
            os.close(fd)

    @staticmethod
    def _verified(directory, project, archive_id):
        fd = os.open(archive_id + ".zip", _FILE_FLAGS, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not _private(info):
                raise ValueError("Unsafe archive")
            stream = os.fdopen(fd, "rb")
        except BaseException:
            os.close(fd)
            raise
        try:
            if _transfer(stream) != archive_id:
                raise ValueError("Archive digest mismatch")
            with zipfile.ZipFile(stream) as archive:
                embedded_project, _, _, _ = _read_manifest(archive)
            if embedded_project != project or _fingerprint(os.fstat(stream.fileno())) != _fingerprint(info):
                raise ValueError("Archive identity mismatch")
            stream.seek(0)
            return stream, info.st_size
        except BaseException:
            stream.close()
            raise

    def list(self, project):
        """Return sorted IDs and exact sizes of verified archives in one project."""
        project = _project_name(project)
        entries = []
        try:
            with self._project(project) as directory:
                for name in sorted(os.listdir(directory)):
                    archive_id = name.removesuffix(".zip")
                    if name == archive_id or not _SHA256.fullmatch(archive_id):
                        continue
                    try:
                        stream, size = self._verified(directory, project, archive_id)
                    except _UNAVAILABLE:
                        continue
                    with stream:
                        entries.append({"id": archive_id, "size_bytes": size})
        except OSError:
            return []
        return entries

    def open(self, project, id):
        """Return (binary stream positioned at zero, length). Caller closes it."""
        project = _project_name(project)
        if not isinstance(id, str) or not _SHA256.fullmatch(id):
            raise FileNotFoundError("Project archive is unavailable")
        try:
            with self._project(project) as directory:
                return self._verified(directory, project, id)
        except _UNAVAILABLE:
            raise FileNotFoundError("Project archive is unavailable") from None
