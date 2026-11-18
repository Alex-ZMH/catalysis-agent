"""Offline, verified backups of a single project."""
from contextlib import closing
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import zipfile
import zlib

from packages.agent.records import validate_run


_MANIFEST = "backup-manifest.json"
_MARKER = "restored-project.json"
_DATABASE = "approvals/approvals.sqlite3"
_SIDECARS = {_DATABASE + suffix for suffix in ("-wal", "-shm", "-journal")}
_SHA256 = re.compile(r"[0-9a-f]{64}")
_RUN_ID = re.compile(r"run-[0-9a-f]{64}")
_PROJECT = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}")


def _project_name(project):
    if not isinstance(project, str) or not _PROJECT.fullmatch(project):
        raise ValueError("Invalid project ID")
    return project


def _path(path):
    path = Path(path).absolute()
    if any(part in {"..", ".git"} or part.startswith(".import-") for part in path.parts):
        raise ValueError(f"Unsafe path: {path}")
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink():
            raise ValueError(f"Symbolic link: {parent}")
        git = parent / ".git"
        if git.exists() or git.is_symlink():
            raise ValueError(f"Project recovery paths must be outside Git worktrees: {parent}")
    return path


def _overlap(first, second):
    if first.is_relative_to(second) or second.is_relative_to(first):
        raise ValueError("Archive and project paths overlap")


def _member(name):
    if not isinstance(name, str) or any(
        part in {"", ".", "..", ".git"} or part.startswith(".import-") or re.search(r"[\\:\x00-\x1f\x7f]", part)
        for part in name.split("/")
    ):
        raise ValueError(f"Unsafe archive path: {name!r}")
    return name


def _fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def _inventory(root):
    files, directories = {}, {}

    def scan(path):
        info = path.lstat()
        name = path.relative_to(root).as_posix()
        if path != root:
            _member(name)
        if stat.S_ISDIR(info.st_mode):
            if name in {_MARKER, _MANIFEST, _DATABASE} | _SIDECARS:
                raise ValueError(f"Reserved project path is a directory: {name}")
            directories[name] = _fingerprint(info)
            for child in sorted(path.iterdir()):
                scan(child)
        elif path != root and stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            if name == _MANIFEST:
                raise ValueError(f"Reserved project path: {name}")
            files[name] = _fingerprint(info)
        else:
            raise ValueError(f"Unsafe project entry: {path}")

    scan(root)
    return files, directories


def _open_regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stream = os.fdopen(fd, "rb")
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        stream.close()
        raise ValueError(f"Unsafe file: {path}")
    return stream


def _transfer(source, dest=None):
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
        if dest is not None:
            dest.write(chunk)
    return digest.hexdigest()


def _copy_checked(path, fingerprint, dest):
    with _open_regular(path) as source:
        if _fingerprint(os.fstat(source.fileno())) != fingerprint:
            raise ValueError(f"Project changed during backup: {path}")
        result = _transfer(source, dest)
        if _fingerprint(os.fstat(source.fileno())) != fingerprint:
            raise ValueError(f"Project changed during backup: {path}")
        return result


def _check_database_header(path):
    with path.open("rb") as source:
        if source.read(16) != b"SQLite format 3\x00":
            raise ValueError("Invalid approval database header")


def _check_database(db):
    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("Approval database failed integrity check")


def _snapshot_database(root, files, staging):
    source = staging / "source.sqlite3"
    for name in sorted(({_DATABASE} | _SIDECARS) & files.keys()):
        suffix = name[len(_DATABASE):]
        if suffix == "-shm":
            continue  # SQLite rebuilds this index from the copied WAL.
        with (staging / (source.name + suffix)).open("xb") as dest:
            _copy_checked(root / name, files[name], dest)
    _check_database_header(source)
    snapshot = staging / "snapshot.sqlite3"
    with closing(sqlite3.connect(source)) as original, closing(sqlite3.connect(snapshot)) as dest:
        original.backup(dest)
        if dest.execute("PRAGMA journal_mode=DELETE").fetchone() != ("delete",):
            raise ValueError("Could not finalize standalone approval database")
        _check_database(dest)
    return snapshot


def _document(path):
    with _open_regular(path) as stream:
        value = json.load(stream, object_pairs_hook=_unique_object)
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def _validate_approvals(database, project, sources, files):
    uri = database.as_uri() + "?mode=ro&immutable=1"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        _check_database(db)
        for plan_id, content in db.execute("SELECT id, record FROM approvals"):
            try:
                plan = json.loads(content, object_pairs_hook=_unique_object)
                spec = plan["spec"]
                identity = hashlib.sha256(json.dumps(
                    [project, spec], ensure_ascii=False, allow_nan=False,
                    sort_keys=True, separators=(",", ":")
                ).encode("utf-8")).hexdigest()
                if plan_id != "plan-" + identity or plan["id"] != plan_id or plan["digest"] != identity:
                    raise ValueError("Approval identity differs")
                if (spec["mode"], spec["workflow"]) == ("slurm-md", "md-lammps"):
                    provenance = spec["provenance"]
                    request = spec["request_id"]
                    path = f"approvals/md-slurm/requests/{request}/bundle.zip"
                    if provenance["project_id"] != project or path not in files:
                        raise ValueError("MD approval source differs from the project")
                    if "run_id" in provenance and provenance["run_id"] not in sources:
                        raise ValueError("MD approval source run is absent")
                else:
                    source = sources[spec["run_id"]]
                    required = {"run_id", "source_sha256", "origin"}
                    if not required <= spec.keys() or any(
                        spec[field] != value for field, value in source.items() if field in spec
                    ):
                        raise ValueError("Approval source differs from the published run")
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"Invalid approval source linkage: {plan_id}") from error


def _validate_project(root, project, directories, hashes, size, database):
    if not {"raw", "runs"} <= set(directories):
        raise ValueError("Project must contain raw and runs directories")
    for name, checksum in hashes.items():
        if name.startswith("raw/") and name != f"raw/{checksum[:2]}/{checksum}":
            raise ValueError(f"Raw blob does not match its content-addressed path: {name}")

    sources = {}
    for base in sorted(name for name in directories if name.startswith("runs/")
                       and name.count("/") == 1):
        run_id = base.split("/")[1]
        if not _RUN_ID.fullmatch(run_id):
            raise ValueError(f"Unexpected run directory: {base}")
        required = {f"{base}/{kind}.json" for kind in ("manifest", "summary", "index")}
        if not required <= hashes.keys():
            raise ValueError(f"Incomplete published run: {run_id}")
        manifest = _document(root / base / "manifest.json")
        summary = _document(root / base / "summary.json")
        index = _document(root / base / "index.json")
        validate_run(manifest)
        if ((manifest["project_id"], manifest["run_id"], summary.get("id"))
                != (project, run_id, run_id)
                or summary.get("kind") != manifest["method"]["id"]):
            raise ValueError(f"Published run identity mismatch: {run_id}")
        records = {record["artifact_id"]: record for record in manifest["artifacts"]}
        for record in records.values():
            checksum = record["sha256"]
            name = f"raw/{checksum[:2]}/{checksum}"
            if hashes.get(name) != checksum or size(name) != record["size_bytes"]:
                raise ValueError(f"Missing or invalid run artifact: {run_id}/{record['artifact_id']}")
        try:
            raw = records[index["raw"]]
            slots = [index[key] for key in ("input", "result", "details")]
            reference = records[index["reference_id"]] if "reference_id" in index else None
            if (raw["role"] != "source" or raw["origin"] != summary["origin"]
                    or index["names"][index["raw"]] != summary["filename"]
                    or records.keys() != index["names"].keys()
                    or any(slot not in records for slot in slots)
                    or not {index["result"], index["details"]} <= set(manifest["outputs"])
                    or index["input"] not in {*manifest["inputs"], manifest["parameters_artifact"]}
                    or (reference is not None
                        and (reference["role"] != "source" or reference == raw))):
                raise ValueError("Index disagrees with published run")
        except (KeyError, TypeError, AttributeError, ValueError) as error:
            raise ValueError(f"Invalid run index: {run_id}") from error
        sources[run_id] = dict(run_id=run_id, run_kind=summary["kind"],
                               origin=raw["origin"], source_name=summary["filename"],
                               source_sha256=raw["sha256"], source_id=index["raw"],
                               source_commit=manifest["code_commit"])
    if any(name.startswith("runs/") and name.count("/") == 1 for name in hashes):
        raise ValueError("Unexpected file in runs directory")
    if database is not None:
        _check_database_header(database)
        _validate_approvals(database, project, sources, hashes)


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _mkdir(path):
    if not path.exists():
        _mkdir(path.parent)
        path.mkdir(exist_ok=True)
        _sync_directory(path.parent)


def _rename_noreplace(source, target):
    # POSIX rename can replace an empty directory. Linux provides an atomic
    # no-replace operation, including when two restores race to publish.
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                       ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), target)


def backup_project(data_dir, project, archive):
    """Publish an archive without replacement and return project and archive_sha256."""
    root = _path(Path(data_dir) / "projects" / _project_name(project))
    archive = _path(archive)
    _overlap(root, archive)
    if archive.exists():
        raise FileExistsError(archive)
    files, directories = _inventory(root)
    if files.keys() & _SIDECARS and _DATABASE not in files:
        raise ValueError("Approval database sidecars exist without the database")

    if not {"raw", "runs"} <= directories.keys():
        raise ValueError("Project must contain raw and runs directories")
    _mkdir(archive.parent)
    with tempfile.TemporaryDirectory(dir=archive.parent, prefix=".backup-") as temp:
        staging = Path(temp)
        snapshot = _snapshot_database(root, files, staging) if _DATABASE in files else None
        candidate = staging / "project.zip"
        hashes = {}
        with candidate.open("x+b") as stream:
            os.fchmod(stream.fileno(), 0o600)
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as output:
                for name in sorted(files.keys() - _SIDECARS - {_MARKER}):
                    with output.open(name, "w", force_zip64=True) as dest:
                        if name == _DATABASE:
                            with snapshot.open("rb") as source:
                                hashes[name] = _transfer(source, dest)
                        else:
                            hashes[name] = _copy_checked(root / name, files[name], dest)
                manifest = dict(version=1, project=project, files=hashes,
                                directories=sorted(directories.keys() - {"."}))
                output.writestr(_MANIFEST, json.dumps(manifest, sort_keys=True))
            stream.flush()
            os.fsync(stream.fileno())
            stream.seek(0)
            archive_sha256 = _transfer(stream)
        _validate_project(root, project, directories, hashes, lambda name: files[name][3], snapshot)
        if _inventory(root) != (files, directories):
            raise ValueError("Project changed during backup")
        _path(root)
        _path(archive)
        _rename_noreplace(candidate, archive)
        _sync_directory(archive.parent)
    return dict(project=project, archive_sha256=archive_sha256)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate manifest key: {key}")
        result[key] = value
    return result


def _read_manifest(archive):
    members = {}
    for info in archive.infolist():
        name = _member(info.orig_filename)
        mode = stat.S_IFMT(info.external_attr >> 16)
        if name in members or mode not in (0, stat.S_IFREG) or info.external_attr & 0x10:
            raise ValueError(f"Duplicate or non-regular archive entry: {name}")
        members[name] = info
    if _MANIFEST not in members:
        raise ValueError("Missing backup manifest")
    manifest = json.loads(archive.read(members.pop(_MANIFEST)), object_pairs_hook=_unique_object)
    if (not isinstance(manifest, dict)
            or manifest.keys() != {"version", "project", "files", "directories"}
            or type(manifest["version"]) is not int or manifest["version"] != 1
            or not isinstance(manifest["files"], dict)
            or not isinstance(manifest["directories"], list)):
        raise ValueError("Invalid backup manifest")
    project = _project_name(manifest["project"])
    files = manifest["files"]
    directories = {_member(name) for name in manifest["directories"]}
    if (len(directories) != len(manifest["directories"]) or files.keys() != members.keys()
            or directories & files.keys()):
        raise ValueError("Archive and manifest entries do not match")
    for name in directories | files.keys():
        _member(name)
        if name in {_MANIFEST, _MARKER} | _SIDECARS:
            raise ValueError(f"Reserved archive path: {name}")
        parent = name.rpartition("/")[0]
        if parent and parent not in directories:
            raise ValueError(f"Missing parent directory: {name}")
    if _DATABASE in directories or any(
        not isinstance(value, str) or not _SHA256.fullmatch(value) for value in files.values()
    ):
        raise ValueError("Invalid database path or file digest")
    return project, directories, files, members


def _restore(source, archive_path, data_dir, expected):
    fingerprint = _fingerprint(os.fstat(source.fileno()))
    if _transfer(source) != expected:
        raise ValueError("Archive SHA-256 mismatch")
    source.seek(0)
    with zipfile.ZipFile(source) as archive:
        project, directories, files, members = _read_manifest(archive)
        root = _path(Path(data_dir) / "projects" / project)
        _overlap(root, archive_path)
        if root.exists():
            raise FileExistsError(root)
        _mkdir(root.parent)
        with tempfile.TemporaryDirectory(dir=root.parent, prefix=".restore-") as temp:
            staging = Path(temp) / project
            staging.mkdir(mode=0o700)
            staging.chmod(0o700)
            for name in sorted(directories):
                directory = staging / name
                directory.mkdir(mode=0o700)
                directory.chmod(0o700)
            for name, digest in files.items():
                with archive.open(members[name]) as content, (staging / name).open("xb") as dest:
                    os.fchmod(dest.fileno(), 0o600)
                    if _transfer(content, dest) != digest:
                        raise ValueError(f"File SHA-256 mismatch: {name}")
                    dest.flush()
                    os.fsync(dest.fileno())
            database = staging / _DATABASE if _DATABASE in files else None
            _validate_project(staging, project, directories, files,
                              lambda name: (staging / name).stat().st_size, database)
            result = dict(project=project, archive_sha256=expected)
            with (staging / _MARKER).open("x", encoding="utf-8") as marker:
                os.fchmod(marker.fileno(), 0o600)
                json.dump(result, marker, sort_keys=True)
                marker.write("\n")
                marker.flush()
                os.fsync(marker.fileno())
            for path in sorted(directories, key=lambda name: name.count("/"), reverse=True):
                _sync_directory(staging / path)
            _sync_directory(staging)
            source.seek(0)
            if _transfer(source) != expected or _fingerprint(os.fstat(source.fileno())) != fingerprint:
                raise ValueError("Archive changed during restore")
            _path(root)
            _rename_noreplace(staging, root)
            _sync_directory(root.parent)
    return result


def restore_project(archive, data_dir, *, expected_sha256):
    """Verify an externally supplied digest and atomically restore a new project."""
    if not isinstance(expected_sha256, str) or not _SHA256.fullmatch(expected_sha256.lower()):
        raise ValueError("An external archive SHA-256 is required")
    archive = _path(archive)
    with _open_regular(archive) as source:
        try:
            return _restore(source, archive, data_dir, expected_sha256.lower())
        except (zipfile.BadZipFile, sqlite3.DatabaseError, EOFError, zlib.error) as error:
            raise ValueError("Corrupt project archive") from error
