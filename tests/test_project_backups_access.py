"""Archive inventory and download operate only on verified private A7 backups."""
import hashlib
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from packages.agent.backup import backup_project
from packages.agent.project_backups import ProjectBackups


class ProjectBackupsAccessTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(self.enterContext(TemporaryDirectory()))
        self.root = self.base / "archives"
        self.root.mkdir(mode=0o700)
        self.alpha = self.root / "alpha"
        self.alpha.mkdir(mode=0o700)
        self.catalog = ProjectBackups(self.root)

    def archive(self, project="alpha", content=b"operator data"):
        data = self.base / "data"
        source = data / "projects" / project
        for directory in ("raw", "runs"):
            (source / directory).mkdir(parents=True, exist_ok=True)
        (source / "private-note.txt").write_bytes(content)
        temporary = self.base / "original.zip"
        archive_id = backup_project(data, project, temporary)["archive_sha256"]
        target = self.alpha / f"{archive_id}.zip"
        temporary.rename(target)
        return archive_id, target

    def unavailable(self, archive_id, project="alpha"):
        with self.assertRaises(FileNotFoundError) as error:
            self.catalog.open(project, archive_id)
        self.assertEqual(str(error.exception), "Project archive is unavailable")
        self.assertNotIn(archive_id, [entry["id"] for entry in self.catalog.list(project)])

    def test_catalog_orders_verified_ids_and_returns_same_binary_bytes(self):
        good = [self.archive(content=data) for data in (b"first", b"second")]
        (self.alpha / "private-original-name.zip").write_bytes(b"not published")
        (self.alpha / ".incoming").write_bytes(b"not yet published")
        expected = [{"id": key, "size_bytes": path.stat().st_size} for key, path in sorted(good)]
        self.assertEqual(self.catalog.list("alpha"), expected)
        self.assertEqual(self.catalog.list("missing"), [])
        for archive_id, path in good:
            stream, size = self.catalog.open("alpha", archive_id)
            with stream:
                self.assertEqual(stream.tell(), 0)
                self.assertEqual(size, path.stat().st_size)
                self.assertEqual(stream.read(4), b"PK\x03\x04")
                stream.seek(0)
                self.assertEqual(stream.read(), path.read_bytes())

    def test_reject_invalid_selectors(self):
        archive_id, _ = self.archive()
        for project in ("../alpha", "/alpha", "x/alpha", ".", "", None):
            with self.subTest(project=project), self.assertRaisesRegex(ValueError, "^Invalid project ID$"):
                self.catalog.open(project, archive_id)
            with self.assertRaises(ValueError):
                self.catalog.list(project)
        for bad_id in (archive_id + ".zip", archive_id.upper(), "../" + archive_id, "", "f" * 64):
            self.unavailable(bad_id)

    def test_reject_wrong_project_even_with_correct_digest_and_tampered_archive(self):
        foreign, _ = self.archive("other")
        self.unavailable(foreign)
        correct, path = self.archive()
        with path.open("ab") as stream:
            stream.write(b"appended")
        self.unavailable(correct)

    def test_reject_malformed_zip_even_with_correct_digest(self):
        data = b"not an A7 backup"
        archive_id = hashlib.sha256(data).hexdigest()
        path = self.alpha / f"{archive_id}.zip"
        path.touch(mode=0o600)
        path.write_bytes(data)
        self.unavailable(archive_id)

    def test_reject_symlink_hardlink_fifo_and_public_permissions(self):
        archive_id, path = self.archive()
        path.chmod(0o644)
        self.unavailable(archive_id)
        path.chmod(0o600)
        elsewhere = self.base / "outside.zip"
        os.link(path, elsewhere)
        self.unavailable(archive_id)
        path.unlink()
        path.symlink_to(elsewhere)
        self.unavailable(archive_id)
        path.unlink()
        os.mkfifo(path, 0o600)
        self.unavailable(archive_id)
        path.unlink()
        path.mkdir(mode=0o700)
        self.unavailable(archive_id)

    def test_reject_nonprivate_directories_and_symlink_at_any_level(self):
        archive_id, _ = self.archive()
        for directory in (self.root, self.alpha):
            directory.chmod(0o755)
            self.unavailable(archive_id)
            directory.chmod(0o700)
        (self.root / "alias").symlink_to(self.alpha, target_is_directory=True)
        self.unavailable(archive_id, "alias")
        alias = self.base / "path-alias"
        alias.symlink_to(self.base, target_is_directory=True)
        self.catalog = ProjectBackups(alias / self.root.name)
        self.unavailable(archive_id)
