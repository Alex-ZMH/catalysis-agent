"""Run a generated LAMMPS job with an operator-selected executable."""
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from zipfile import BadZipFile, ZipFile
from io import BytesIO
import shutil
import sys

from .science import md_job


_INPUTS = ("in.md", "structure.data", "md-config.json")
_NATIVE = ("log.lammps", "trajectory.lammpstrj", "final.data", "final.restart")
_SIGNALS = (signal.SIGINT, signal.SIGTERM)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _write_record(directory, record):
    temporary = directory / "run.json.tmp"
    temporary.write_text(json.dumps(record, indent=2, ensure_ascii=False, allow_nan=False) + "\n",
                         encoding="utf-8")
    temporary.replace(directory / "run.json")


def _regular_input(path):
    if not path.is_file():
        raise ValueError(f"Expected a regular input file: {path}")
    return path


def _read_job_bundle(path):
    def read_member(archive, name):
        info = archive.getinfo(name)
        if not 0 < info.file_size <= 128 * 1024**2 or info.is_dir():
            raise ValueError(f"Invalid size for job bundle member: {name}")
        return archive.read(info)

    with ZipFile(_regular_input(path)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate names in job bundle")
        meta = json.loads(read_member(archive, "md-config.json"))
        if not isinstance(meta, dict) or meta.get("version") != 1:
            raise ValueError("Expected a version 1 MD job bundle")
        files = meta.get("files")
        if not isinstance(files, dict):
            raise ValueError("Missing job bundle file declarations")
        source = files.get("source")
        if (not isinstance(source, str) or not re.fullmatch(r"source/[^/\\]+", source)
                or source.rsplit("/", 1)[-1] in {".", ".."}):
            raise ValueError("Invalid job bundle source member")
        name = source.split("/", 1)[1]
        potential_name = files.get("potential")
        if potential_name not in (None, "potential.eam.alloy"):
            raise ValueError("Invalid job bundle potential member")
        raw = read_member(archive, source)
        potential = read_member(archive, potential_name) if potential_name is not None else None
    return name, raw, meta["config"], potential, meta.get("provenance")


def _stage(directory, name, raw, config, potential, provenance):
    bundle = md_job.build_job(name, raw, config, potential=potential, provenance=provenance)
    with ZipFile(BytesIO(bundle)) as archive:
        names = archive.namelist()
        expected = {*_INPUTS, "source/" + name}
        if potential is not None:
            expected.add("potential.eam.alloy")
        if set(names) != expected or len(names) != len(expected):
            raise ValueError("Unexpected files in generated LAMMPS bundle")
        (directory / "source").mkdir()
        for name in names:
            with archive.open(name) as data, (directory / name).open("xb") as target:
                shutil.copyfileobj(data, target)
    return json.loads((directory / "md-config.json").read_text(encoding="utf-8"))


def _git_commit():
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parents[1],
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _engine(path):
    if not path.is_absolute():
        raise ValueError("--engine must be an absolute path to an admin-trusted executable")
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise ValueError("--engine must point to an executable regular file")
    return str(resolved)


def _invoke(argv, directory, stdout, stderr, interrupted, timeout=None):
    if interrupted():
        return None
    with (directory / stdout).open("xb") as out, (directory / stderr).open("xb") as err:
        with subprocess.Popen(argv, cwd=directory, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                              start_new_session=True) as child:
            deadline = time.monotonic() + timeout if timeout is not None else math.inf
            while True:
                if interrupted() or time.monotonic() >= deadline:
                    try:
                        os.killpg(child.pid, interrupted() or signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        code = child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        code = child.wait()
                    if not interrupted():
                        raise RuntimeError("LAMMPS version probe timed out")
                    return code
                try:
                    return child.wait(timeout=0.2)
                except subprocess.TimeoutExpired:
                    continue


def _version(path):
    with path.open(encoding="utf-8", errors="replace") as stream:
        for _ in range(12):
            line = stream.readline(4096).strip()
            if line.startswith(("LAMMPS (", "Large-scale Atomic/Molecular Massively Parallel Simulator")):
                return line
    return None


def _thermo(log, destination):
    """Stream LAMMPS thermo_style custom blocks as JSON Lines."""
    rows = 0
    columns = []
    with log.open(encoding="utf-8", errors="replace") as source, destination.open("x", encoding="utf-8") as out:
        for line in source:
            fields = line.split()
            if fields and fields[0] == "Step" and len(fields) > 1 and len(set(fields)) == len(fields):
                columns = fields
                continue
            if not columns or len(fields) != len(columns) or not re.fullmatch(r"[+-]?[0-9]+", fields[0]):
                if fields:
                    columns = []
                continue
            try:
                numbers = [float(value) for value in fields[1:]]
                row = dict(zip(columns, [int(fields[0]), *(value if math.isfinite(value) else None
                                                           for value in numbers)], strict=True))
            except ValueError:
                columns = []
                continue
            out.write(json.dumps(row, allow_nan=False) + "\n")
            rows += 1
    return rows


def run_md(structure, config, engine, output_dir, *, potential=None, job_bundle=None):
    """Run once in a fresh directory and return the persisted run.json record."""
    if job_bundle is None:
        if structure is None or config is None:
            raise ValueError("--structure and --config are required without --job-bundle")
        structure, config = Path(structure), Path(config)
        potential = Path(potential) if potential is not None else None
    elif any(value is not None for value in (structure, config, potential)):
        raise ValueError("--job-bundle cannot be combined with --structure, --config or --potential")
    else:
        job_bundle = Path(job_bundle)
    engine, directory = Path(engine), Path(output_dir)
    directory.mkdir(mode=0o700)
    directory = directory.resolve()
    started = time.monotonic()
    caught = None

    def note_signal(signum, _frame):
        nonlocal caught
        if caught is None:
            caught = signum

    def interrupted():
        return caught

    record = {
        "schema_version": 1, "status": "running", "phase": "staging", "started_at": _now(),
        "finished_at": None, "elapsed_seconds": None, "code_commit": None,
        "slurm_job_id": os.environ.get("SLURM_JOB_ID"), "signal": None,
        "inputs": {"structure": structure.name if structure is not None else None,
                   "config": config.name if config is not None else "md-config.json",
                   "potential": potential.name if potential is not None else None,
                   "job_bundle": job_bundle.name if job_bundle is not None else None},
        "provenance": None,
        "engine": {"requested": str(engine), "path": None, "version": None, "version_argv": None,
                   "argv": None, "version_returncode": None, "returncode": None},
        "parameters": None, "units": None, "files": [], "thermo_rows": None, "error": None,
    }
    handlers = {signum: signal.signal(signum, note_signal) for signum in _SIGNALS}
    try:
        _write_record(directory, record)
        record["code_commit"] = _git_commit()
        executable = _engine(engine)
        engine_info = record["engine"]
        engine_info.update(path=executable, version_argv=[executable, "-help"],
                           argv=[executable, "-in", "in.md", "-log", "log.lammps"])
        if not caught:
            if job_bundle is None:
                name = structure.name
                raw = _regular_input(structure).read_bytes()
                settings = json.loads(_regular_input(config).read_text(encoding="utf-8-sig"))
                potential_bytes = _regular_input(potential).read_bytes() if potential is not None else None
                provenance = None
            else:
                name, raw, settings, potential_bytes, provenance = _read_job_bundle(job_bundle)
                record["inputs"]["structure"] = name
            bundle = _stage(directory, name, raw, settings, potential_bytes, provenance)
            record["provenance"] = bundle.get("provenance")
            if job_bundle is not None and potential_bytes is not None:
                metadata = record["provenance"] or {}
                original_name = metadata.get("potential_filename") or metadata.get("source_potential_filename")
                record["inputs"]["potential"] = original_name if isinstance(original_name, str) else "potential.eam.alloy"
            record["parameters"] = bundle["config"]
            record["units"] = bundle["structure"]["units"]
        if not caught:
            record["phase"] = "version"
            _write_record(directory, record)
            engine_info["version_returncode"] = _invoke(
                engine_info["version_argv"], directory, "engine-help.stdout.log", "engine-help.stderr.log",
                interrupted, timeout=15,
            )
            if engine_info["version_returncode"] is not None:
                engine_info["version"] = (_version(directory / "engine-help.stdout.log")
                                          or _version(directory / "engine-help.stderr.log"))
            if not caught and engine_info["version_returncode"] != 0:
                raise RuntimeError(f"LAMMPS version probe exited {engine_info['version_returncode']}")
        if not caught:
            record["phase"] = "solver"
            _write_record(directory, record)
            engine_info["returncode"] = _invoke(
                engine_info["argv"], directory, "stdout.log", "stderr.log", interrupted,
            )
            if engine_info["returncode"] in {-signum for signum in _SIGNALS} and not caught:
                caught = -engine_info["returncode"]
        if (directory / "log.lammps").is_file():
            record["thermo_rows"] = _thermo(directory / "log.lammps", directory / "thermo.jsonl")
        if not caught:
            if engine_info["returncode"] != 0:
                raise RuntimeError(f"LAMMPS exited {engine_info['returncode']}")
            missing = [name for name in _NATIVE
                       if not (directory / name).is_file() or not (directory / name).stat().st_size]
            if missing:
                raise RuntimeError("LAMMPS finished without required output: " + ", ".join(missing))
            record.update(status="completed", phase="finished")
    except (OSError, ValueError, RuntimeError, OverflowError, TypeError, KeyError, EOFError, BadZipFile) as error:
        record.update(status="failed", error=str(error))
    finally:
        try:
            if caught:
                record.update(status="interrupted", signal=int(caught), error=f"Received {signal.Signals(caught).name}")
            record.update(finished_at=_now(), elapsed_seconds=time.monotonic() - started,
                          files=sorted(str(path.relative_to(directory)) for path in directory.rglob("*")
                                       if path.is_file() and path != directory / "run.json"))
            _write_record(directory, record)
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--structure", type=Path)
    source.add_argument("--job-bundle", type=Path, help="Downloaded MD job ZIP to regenerate locally")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--potential", type=Path)
    parser.add_argument("--engine", required=True, type=Path,
                        help="Absolute path to an admin-trusted LAMMPS executable")
    parser.add_argument("--output-dir", required=True, type=Path, help="New run directory under an existing parent")
    args = parser.parse_args(argv)
    if args.job_bundle is not None and (args.config is not None or args.potential is not None):
        parser.error("--job-bundle cannot be combined with --config or --potential")
    if args.structure is not None and args.config is None:
        parser.error("--structure requires --config")
    try:
        record = run_md(args.structure, args.config, args.engine, args.output_dir,
                        potential=args.potential, job_bundle=args.job_bundle)
    except OSError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(record, ensure_ascii=False, allow_nan=False))
    if record["status"] == "interrupted":
        return 128 + record["signal"]
    return int(record["status"] != "completed")


if __name__ == "__main__":
    sys.exit(main())
