"""Exercise offline project backup and recovery without a scheduler."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
from threading import Barrier
import unittest
from unittest.mock import patch
import warnings
import zipfile

from packages.agent import backup
from packages.agent.approvals import ApprovalStore


PROJECT = "catalysis"
RUN_ID = "run-" + "1" * 64
MANIFEST = "backup-manifest.json"
DATABASE = "approvals/approvals.sqlite3"


def sha256(content):
    return hashlib.sha256(content).hexdigest()


class LostReceiptScheduler:
    def prepare(self, plan):
        pass

    def submit(self, plan):
        raise TimeoutError("fake lost receipt")


class ProjectBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.source = self.base / "source"
        self.project = self.source / "projects" / PROJECT
        self.destination = self.base / "destination"
        self.restored = self.destination / "projects" / PROJECT
        self.archive = self.base / "project.zip"
        self.files = {
            "approvals/slurm/plan-one/submitted-123.json": b'{"job_id":"123"}',
            "approvals/slurm/plan-one/result-123.json": b'{"result":"verified"}',
        }
        artifacts = []
        for name, role, content, parents in (
            ("source", "source", b"scientific bytes", []),
            ("parameters", "parameters", b"{}", []),
            ("result", "derived", b'{"result":true}', ["source", "parameters"]),
            ("details", "derived", b'{"details":true}', ["source", "parameters"]),
        ):
            digest = sha256(content)
            self.files[f"raw/{digest[:2]}/{digest}"] = content
            artifacts.append(dict(artifact_id=name, project_id=PROJECT, sha256=digest,
                                  size_bytes=len(content), format="binary", origin="synthetic",
                                  role=role, parents=parents))
        self.source_sha = artifacts[0]["sha256"]
        self.spec = dict(run_id=RUN_ID, workflow="synthetic-v100", cpus=1, gpus=1,
                         minutes=1, source_sha256=self.source_sha, origin="synthetic",
                         mode="plan-only", source_id="source", run_kind="md",
                         source_name="input.lammpstrj", source_commit="a" * 40)
        stamp = "2026-11-18T00:00:00Z"
        documents = {
            "manifest": dict(
                schema_version="1.0.0", project_id=PROJECT, run_id=RUN_ID,
                operator_id="operator", recorded_at=stamp, operation="md.import",
                method={"id": "md", "version": "0.1.0"}, code_commit="a" * 40,
                profile="intranet-v1", parameters_artifact="parameters", inputs=["source"],
                outputs=["result", "details"], artifacts=artifacts,
                quality="accepted", quality_flags=[],
            ),
            "summary": dict(id=RUN_ID, kind="md", origin="synthetic", created_at=stamp,
                            filename="input.lammpstrj"),
            "index": dict(names={"source": "input.lammpstrj", "parameters": "parameters.json",
                                 "result": "result.json", "details": "details.json"},
                          raw="source", input="parameters", result="result", details="details"),
        }
        for name, document in documents.items():
            self.files[f"runs/{RUN_ID}/{name}.json"] = json.dumps(document).encode()
        for name, data in self.files.items():
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (self.project / "raw/ff").mkdir()

    def backup(self):
        return backup.backup_project(self.source, PROJECT, self.archive)

    def restore(self, digest):
        return backup.restore_project(self.archive, self.destination, expected_sha256=digest)

    def make_archive(self, entries, files=None, directories=None):
        if files is None:
            files = {"raw/blob": sha256(b"original")}
        if directories is None:
            directories = ["raw", "runs"]
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Duplicate name:", category=UserWarning)
            with zipfile.ZipFile(self.archive, "w") as output:
                output.writestr(MANIFEST, json.dumps(dict(
                    version=1, project=PROJECT, files=files, directories=directories
                )))
                for name, content in entries:
                    output.writestr(name, content)
        return sha256(self.archive.read_bytes())

    def test_round_trip_includes_uncheckpointed_sqlite_and_slurm_files(self):
        store = ApprovalStore(self.source, PROJECT, "operator")
        with closing(sqlite3.connect(self.project / DATABASE)) as connection:
            self.assertEqual(connection.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
            connection.execute("BEGIN")
            connection.execute("SELECT record FROM approvals").fetchall()
            plan = store.create(self.spec)
            confirmed = store.confirm(plan["id"], plan["digest"])
            pending = store.create(dict(self.spec, minutes=2))
            unknown = ApprovalStore(self.source, PROJECT, "operator", LostReceiptScheduler())
            lost = unknown.create(dict(self.spec, mode="slurm-synthetic"))
            lost = unknown.confirm(lost["id"], lost["digest"])
            self.assertEqual(lost["state"], "unknown")
            wal = self.project / (DATABASE + "-wal")
            before = wal.read_bytes()
            self.assertTrue(before)
            result = self.backup()
            self.assertEqual(wal.read_bytes(), before)
        self.assertEqual(result, dict(project=PROJECT, archive_sha256=sha256(self.archive.read_bytes())))
        with zipfile.ZipFile(self.archive) as archive:
            manifest = json.loads(archive.read(MANIFEST))
            self.assertEqual(set(manifest["files"]), self.files.keys() | {DATABASE})
            for name, digest in manifest["files"].items():
                self.assertEqual(sha256(archive.read(name)), digest)

        self.assertEqual(self.restore(result["archive_sha256"]), result)
        self.assertEqual(json.loads((self.restored / "restored-project.json").read_bytes()), result)
        for name, content in self.files.items():
            self.assertEqual((self.restored / name).read_bytes(), content)
        self.assertTrue((self.restored / "raw/ff").is_dir())
        self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.restored.stat().st_mode), 0o700)
        self.assertFalse((self.restored / (DATABASE + "-wal")).exists())
        self.assertEqual(ApprovalStore(self.destination, PROJECT, "reader").list(), [confirmed, pending, lost])

    def test_external_digest_required_and_bit_corruption_leaves_no_project(self):
        digest = self.backup()["archive_sha256"]
        for invalid in (None, "", "1234", "0" * 64):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.restore(invalid)
        content = self.archive.read_bytes()
        self.archive.write_bytes(content[:-1] + bytes([content[-1] ^ 1]))
        with self.assertRaisesRegex(ValueError, "Archive SHA-256"):
            self.restore(digest)
        self.assertFalse(self.restored.exists())

    def test_malformed_archives_leave_no_publication_or_staging(self):
        link = zipfile.ZipInfo("raw/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in (
            [],
            [("raw/blob", b"original"), ("raw/extra", b"extra")],
            [("raw/blob", b"original"), ("raw/blob", b"original")],
            [("raw/blob", b"changed")],
            [("raw/blob", b"original"), ("../escape", b"escape")],
            [("raw/blob", b"original"), (link, b"/etc/passwd")],
        ):
            with self.subTest(entries=entries):
                digest = self.make_archive(entries)
                with self.assertRaises(ValueError):
                    self.restore(digest)
                self.assertFalse(self.restored.exists())
                self.assertFalse((self.destination / "escape").exists())
                self.assertEqual(list(self.destination.rglob(".restore-*")), [])

    def test_invalid_sqlite_cannot_be_published(self):
        content = b"not a database"
        digest = self.make_archive([(DATABASE, content)], {DATABASE: sha256(content)}, ["approvals", "raw", "runs"])
        with self.assertRaises(ValueError):
            self.restore(digest)
        self.assertFalse(self.restored.exists())

    def test_backup_rejects_links_and_overlapping_paths(self):
        existing = self.project / "raw" / self.source_sha[:2] / self.source_sha
        link = self.project / "raw/link"
        link.symlink_to(existing)
        with self.assertRaises(ValueError):
            self.backup()
        link.unlink()
        os.link(existing, link)
        with self.assertRaises(ValueError):
            self.backup()
        link.unlink()
        with self.assertRaisesRegex(ValueError, "overlap"):
            backup.backup_project(self.source, PROJECT, self.project / "nested.zip")
        self.assertFalse(self.archive.exists())

    def test_restore_rejects_linked_destination_and_overlapping_archive(self):
        digest = self.backup()["archive_sha256"]
        self.destination.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.restore(digest)
        self.destination.unlink()
        self.restored.mkdir(parents=True)
        nested = self.restored / self.archive.name
        self.archive.rename(nested)
        with self.assertRaisesRegex(ValueError, "overlap"):
            backup.restore_project(nested, self.destination, expected_sha256=digest)

    def test_existing_targets_are_preserved(self):
        result = self.backup()
        original = self.archive.read_bytes()
        with self.assertRaises(FileExistsError):
            self.backup()
        self.assertEqual(self.archive.read_bytes(), original)
        self.restored.mkdir(parents=True)
        with self.assertRaises(FileExistsError):
            self.restore(result["archive_sha256"])
        self.assertEqual(list(self.restored.iterdir()), [])

    def test_change_during_backup_aborts_publication(self):
        copy_checked = backup._copy_checked

        def copy_and_change(path, fingerprint, dest):
            digest = copy_checked(path, fingerprint, dest)
            (self.project / "new-file").write_bytes(b"concurrent write")
            return digest

        with patch.object(backup, "_copy_checked", side_effect=copy_and_change):
            with self.assertRaisesRegex(ValueError, "changed during backup"):
                self.backup()
        self.assertFalse(self.archive.exists())
        self.assertEqual(list(self.base.glob(".backup-*")), [])

    def test_concurrent_restore_cannot_replace_a_published_project(self):
        digest = self.backup()["archive_sha256"]
        rendezvous = Barrier(2)
        rename = backup._rename_noreplace

        def simultaneous_publish(source, target):
            rendezvous.wait(timeout=10)
            return rename(source, target)

        with patch.object(backup, "_rename_noreplace", side_effect=simultaneous_publish):
            with ThreadPoolExecutor(max_workers=2) as pool:
                jobs = [pool.submit(self.restore, digest) for _ in range(2)]
                successes = [job.result() for job in jobs if job.exception() is None]
                failures = [job.exception() for job in jobs if job.exception() is not None]
        self.assertEqual(successes, [dict(project=PROJECT, archive_sha256=digest)])
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], FileExistsError)
        self.assertEqual(list(self.destination.rglob(".restore-*")), [])

    def test_git_staging_and_incomplete_layout_are_rejected(self):
        (self.project / "runs/.import-abandoned").mkdir()
        with self.assertRaises(ValueError):
            self.backup()
        (self.project / "runs/.import-abandoned").rmdir()
        (self.source / ".git").write_text("gitdir: elsewhere")
        with self.assertRaises(ValueError):
            self.backup()
        (self.source / ".git").unlink()
        (self.project / "runs").rename(self.project / "incomplete-runs")
        with self.assertRaisesRegex(ValueError, "raw and runs"):
            self.backup()
        self.assertFalse(self.archive.exists())

    def test_referenced_blob_and_manifest_sizes_are_verified(self):
        blob = self.project / "raw" / self.source_sha[:2] / self.source_sha
        original = blob.read_bytes()
        blob.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "content-addressed"):
            self.backup()
        blob.write_bytes(original)
        manifest_path = self.project / "runs" / RUN_ID / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["artifacts"][0]["size_bytes"] += 1
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "invalid run artifact"):
            self.backup()
        self.assertFalse(self.archive.exists())
        files = {**self.files, f"runs/{RUN_ID}/manifest.json": manifest_path.read_bytes()}
        directories = {parent.as_posix() for name in files for parent in Path(name).parents
                       if parent != Path(".")}
        digest = self.make_archive(files.items(), {k: sha256(v) for k, v in files.items()},
                                   sorted(directories))
        with self.assertRaisesRegex(ValueError, "invalid run artifact"):
            self.restore(digest)
        self.assertFalse(self.restored.exists())

    def test_approval_with_mismatched_source_cannot_be_backed_up_or_restored(self):
        store = ApprovalStore(self.source, PROJECT, "operator")
        store.create(dict(self.spec, source_sha256="0" * 64))
        with self.assertRaisesRegex(ValueError, "Invalid approval source linkage"):
            self.backup()
        self.assertFalse(self.archive.exists())
        files = {**self.files, DATABASE: (self.project / DATABASE).read_bytes()}
        directories = {parent.as_posix() for name in files for parent in Path(name).parents
                       if parent != Path(".")}
        digest = self.make_archive(files.items(), {k: sha256(v) for k, v in files.items()},
                                   sorted(directories))
        with self.assertRaisesRegex(ValueError, "Invalid approval source linkage"):
            self.restore(digest)
        self.assertFalse(self.restored.exists())

    def test_backup_creates_archive_parent(self):
        self.archive = self.base / "new" / "nested" / "project.zip"
        self.assertEqual(self.backup()["archive_sha256"], sha256(self.archive.read_bytes()))

    def test_restored_tree_is_private_under_permissive_umask(self):
        store = ApprovalStore(self.source, PROJECT, "operator")
        store.create(self.spec)
        previous = os.umask(0)
        try:
            result = self.backup()
            self.restore(result["archive_sha256"])
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode), 0o600)
        for path in (self.restored, *self.restored.rglob("*")):
            with self.subTest(path=path):
                expected = 0o700 if path.is_dir() else 0o600
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), expected)
