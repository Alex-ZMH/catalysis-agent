"""Project-scoped A6 LAMMPS jobs and a restricted local Slurm broker."""
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
from tempfile import NamedTemporaryFile
from threading import Lock
from zipfile import ZIP_DEFLATED, ZipFile

from .slurm import _atomic_write, _JOB_ID, _PLAN_ID, _private_dir, _read_private, _slurm
from ..science import md_job

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}")
_REQUEST = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_CHECKPOINT = re.compile(r"checkpoint\.([0-9]{1,19})")
_TERMINAL = {"BOOT_FAIL", "CANCELLED", "COMPLETED", "DEADLINE", "FAILED", "NODE_FAIL",
             "OUT_OF_MEMORY", "PREEMPTED", "REVOKED", "SPECIAL_EXIT", "TIMEOUT"}
_ARTIFACTS = ("run.json", "in.md", "log.lammps", "thermo.jsonl", "trajectory.lammpstrj",
              "final.data", "final.restart", "stdout.log", "stderr.log")
_RESOURCES = {"cpus", "gpus", "minutes"}
_ROOT = Path(__file__).resolve().parents[2]


class SchedulerUnavailable(RuntimeError):
    """A scheduler operation failed without establishing a new state."""


def _profile(document):
    defaults = dict(cpu_partition="cpu", gpu_partition="gpu", node="v100", memory=None,
                    max_cpus=16, max_minutes=1440, library_path=[], engine_args=[],
                    gpu_engine=None, gpu_engine_args=[])
    if not isinstance(document, dict) or "engine" not in document or document.keys() - defaults.keys() - {"engine"}:
        raise ValueError("Invalid MD Slurm site configuration fields")
    profile = {**defaults, **document}
    for key in ("engine", "gpu_engine"):
        if key == "gpu_engine" and profile[key] is None:
            continue
        path = Path(profile[key])
        if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
            raise ValueError(f"{key} must be an absolute, executable site LAMMPS path")
        profile[key] = str(path.resolve())
    for key in ("cpu_partition", "gpu_partition", "node"):
        if not isinstance(profile[key], str) or not _ID.fullmatch(profile[key]):
            raise ValueError(f"Invalid Slurm profile {key}")
    if profile["memory"] is not None and not re.fullmatch(r"[1-9][0-9]*[KMGT]?", str(profile["memory"])):
        raise ValueError("Invalid Slurm memory")
    for key in ("max_cpus", "max_minutes"):
        md_job._int(profile[key], key, 10080 if key == "max_minutes" else 256)
    for key in ("library_path", "engine_args", "gpu_engine_args"):
        values = profile[key]
        if not isinstance(values, list) or any(not isinstance(item, str) or "\x00" in item for item in values):
            raise ValueError(f"{key} must be a list of strings")
    if any(not Path(path).is_absolute() or ":" in path for path in profile["library_path"]):
        raise ValueError("library_path entries must be absolute paths")
    return profile


def _resources(options, profile):
    cpus = md_job._int(options.get("cpus"), "cpus", profile["max_cpus"])
    minutes = md_job._int(options.get("minutes"), "minutes", profile["max_minutes"])
    gpus = options.get("gpus")
    if type(gpus) is not int or gpus not in (0, 1):
        raise ValueError("gpus must be 0 or 1")
    if gpus and not profile["gpu_engine"]:
        raise ValueError("The V100 site has not configured a GPU-enabled LAMMPS executable")
    return dict(cpus=cpus, gpus=gpus, minutes=minutes)


def _safe(match, value, label):
    if not isinstance(value, str) or not match.fullmatch(value):
        raise ValueError(f"Invalid {label}")
    return value


def _spool(data_dir, project):
    return Path(data_dir) / "projects" / _safe(_ID, project, "project") / "approvals" / "md-slurm"


def _check_path(path):
    if path.resolve() != path or any(ord(c) < 32 or c == "%" for c in str(path)):
        raise ValueError("Unsafe MD Slurm directory")
    _private_dir(path)
    return path


def _write_bytes(path, content):
    with NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        try:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)


@contextmanager
def _locked(directory):
    import fcntl

    fd = os.open(directory / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def _open_output(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stream = os.fdopen(fd, "rb")
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        stream.close()
        raise ValueError("Unsafe MD result file")
    return stream, info.st_size


def _request_zip(name, raw, config, potential, provenance):
    # Store source inputs only. The runner constructs all executable commands.
    files = {"source": f"source/{name}"}
    if potential is not None:
        files["potential"] = "potential.eam.alloy"
    meta = dict(version=1, files=files, config=config, provenance=provenance)
    buffer = io.BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as zipped:
        zipped.writestr(files["source"], raw)
        zipped.writestr("md-config.json", json.dumps(meta, allow_nan=False))
        if potential is not None:
            zipped.writestr(files["potential"], potential)
    return buffer.getvalue()


def _last_step(log):
    try:
        stream, size = _open_output(log)
    except FileNotFoundError:
        return None
    with stream:
        stream.seek(max(0, size - 65536))
        data = stream.read(65536)
    lines = data.split(b"\n")[int(size > 65536):-1]
    for line in reversed(lines):
        fields = line.split()
        if len(fields) == 7 and re.fullmatch(rb"[0-9]{1,19}", fields[0]):
            try:
                list(map(float, fields[1:]))
            except ValueError:
                continue
            return int(fields[0])
    return None


def _checkpoint_rows(run_dir, plan, runner_state):
    start, end = plan["spec"]["start_step"], plan["spec"]["target_step"]
    checkpoints = [
        {"id": name.name, "step": int(match[1])}
        for name in run_dir.glob("checkpoint.*")
        if (match := _CHECKPOINT.fullmatch(name.name)) and start < int(match[1]) <= end
        and name.is_file() and not name.is_symlink()
    ]
    if runner_state == "completed" and (run_dir / "final.restart").is_file():
        checkpoints.append({"id": "final.restart", "step": end})
    return sorted(checkpoints, key=lambda row: (row["step"], row["id"]))


class MDSlurm:
    def __init__(self, data_dir, project, broker):
        self.project, self.broker = project, broker
        self.root = _spool(data_dir, project)

    def _plan_dir(self, plan_id, create=False):
        directory = self.root / _safe(_PLAN_ID, plan_id, "plan ID")
        if create:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.exists() or directory.is_symlink():
            _check_path(directory)
        return directory

    def create(self, approvals, options, source):
        approvals._require_writable()
        if options.keys() != _RESOURCES | {"config", "request_id"}:
            raise ValueError("MD plan requires config, request_id, cpus, gpus and minutes")
        request_id = _safe(_REQUEST, options["request_id"], "request_id UUID")
        resources = _resources(options, self.broker.profile)
        request = self.root / "requests" / request_id
        request.mkdir(mode=0o700, parents=True, exist_ok=True)
        _check_path(request)
        with _locked(request):
            try:
                spec = json.loads(_read_private(request / "spec.json"))
            except FileNotFoundError:
                config = md_job._config(options["config"])
                if "restart_every" not in config:
                    raise ValueError("config.restart_every is required for Slurm jobs")
                name, raw, potential, provenance = source()
                if (not isinstance(name, str) or not name or name in {".", ".."}
                        or any(c in name for c in "/\\:") or any(ord(c) < 32 for c in name)):
                    raise ValueError("Invalid source filename")
                spec = dict(workflow="md-lammps", mode="slurm-md", policy_id="a6-md-slurm-v1",
                            run_kind="md", source_name=name, origin=provenance.get("origin", "unknown"),
                            request_id=request_id, config=config, provenance=provenance,
                            start_step=0, target_step=config["steps"], restart=None, **resources)
                _write_bytes(request / "bundle.zip", _request_zip(name, raw, config, potential, provenance))
                _atomic_write(request / "spec.json", json.dumps(spec, allow_nan=False))
            return approvals.create(spec)

    def _bundle(self, plan):
        return self.root / "requests" / _safe(_REQUEST, plan["spec"]["request_id"], "request_id") / "bundle.zip"

    def _checkpoint(self, restart):
        name = restart["checkpoint"]
        if name != "final.restart":
            _safe(_CHECKPOINT, name, "checkpoint")
        return self._plan_dir(restart["plan_id"]) / "run" / name

    def prepare(self, plan):
        directory = self._plan_dir(plan["id"], create=True)
        _resources(plan["spec"], self.broker.profile)
        with _open_output(self._bundle(plan))[0]:
            pass
        if restart := plan["spec"]["restart"]:
            with _open_output(self._checkpoint(restart))[0]:
                pass
        dispatch = {key: plan["spec"][key] for key in ("request_id", "restart", *_RESOURCES)}
        _atomic_write(directory / "dispatch.json", json.dumps(dispatch, allow_nan=False))

    def submit(self, plan):
        return self.broker.call("submit", self.project, plan["id"])

    def lookup(self, plan):
        return self.broker.call("lookup", self.project, plan["id"])

    def _runner(self, plan):
        path = self._plan_dir(plan["id"]) / "run" / "run.json"
        try:
            run = json.loads(_read_private(path))
        except FileNotFoundError:
            return {}
        return run if run.get("slurm_job_id") == plan["job_id"] else {}

    def status(self, plan):
        plan_id, job_id = plan["id"], plan["job_id"]
        directory = self._plan_dir(plan_id)
        run_dir = directory / "run"
        run = self._runner(plan)
        runner_state = run.get("status")
        state = reason = None
        if job_id:
            try:
                state, reason = self.broker.call("status", self.project, plan_id, job_id)
            except SchedulerUnavailable as error:
                reason = str(error)
        terminal = state in _TERMINAL
        can_cancel = state is not None and not terminal and state != "COMPLETING"
        step = _last_step(run_dir / "log.lammps") if job_id else None
        start, end = plan["spec"]["start_step"], plan["spec"]["target_step"]
        if runner_state == "completed":
            step = end
        fraction = None if step is None else max(0, min(1, (step - start) / (end - start)))
        checkpoints = _checkpoint_rows(run_dir, plan, runner_state) if job_id else []
        artifacts = [
            {"name": name, "url": f"/api/plans/{plan_id}/artifacts/{name}"}
            for name in _ARTIFACTS if job_id and (run_dir / name).is_file()
        ]
        return dict(plan_id=plan_id, job_id=job_id, approval_state=plan["state"],
                    scheduler_state=state, reason=reason, terminal=terminal,
                    runner_state=runner_state, progress=dict(step=step, start_step=start,
                                                            target_step=end, fraction=fraction),
                    checkpoints=checkpoints, artifacts=artifacts, can_cancel=can_cancel,
                    can_restart=terminal and bool(checkpoints))

    def cancel(self, plan):
        if plan["job_id"] is None:
            raise ValueError("Reconcile the Slurm receipt before cancelling")
        self.broker.call("cancel", self.project, plan["id"], plan["job_id"])
        return self.status(plan)

    def restart(self, approvals, plan, body):
        approvals._require_writable()
        if body.keys() != _RESOURCES | {"checkpoint", "steps"}:
            raise ValueError("Restart requires checkpoint, steps, cpus, gpus and minutes")
        resources = _resources(body, self.broker.profile)
        steps = md_job._int(body["steps"], "additional steps", 2**31 - 1)
        current = self.status(plan)
        if not current["can_restart"]:
            raise ValueError("A terminal job with an available checkpoint is required")
        wanted = next((row for row in current["checkpoints"] if row["id"] == body["checkpoint"]), None)
        if wanted is None:
            raise ValueError("Unknown checkpoint for this plan")
        previous = plan["spec"]
        restart = dict(plan_id=plan["id"], job_id=plan["job_id"], checkpoint=wanted["id"],
                       step=wanted["step"], steps=steps)
        return approvals.create({**previous, **resources, "restart": restart,
                                 "config": {**previous["config"], "steps": steps},
                                 "start_step": wanted["step"], "target_step": wanted["step"] + steps})

    def artifact(self, plan, name):
        if plan["job_id"] is None or name not in _ARTIFACTS:
            raise FileNotFoundError()
        return _open_output(self._plan_dir(plan["id"]) / "run" / name)


def _controller(*args, **kwargs):
    try:
        return _slurm(*args, **kwargs)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SchedulerUnavailable(f"{args[0]} unavailable: {error}") from error


def _jobs(stdout):
    for line in stdout.splitlines():
        fields = dict(re.findall(r"(?:^|\s)(\w+)=(\S+)", line))
        owner = fields.get("UserId", "").rsplit("(", 1)[-1].rstrip(")")
        if owner == str(os.getuid()) and _JOB_ID.fullmatch(fields.get("JobId", "")):
            yield fields


def _script(directory, profile, dispatch):
    request_id = _safe(_REQUEST, dispatch["request_id"], "request_id")
    bundle = directory.parent / "requests" / request_id / "bundle.zip"
    resources = _resources(dispatch, profile)
    use_gpu = resources["gpus"] == 1
    executable = profile["gpu_engine" if use_gpu else "engine"]
    flags = profile["gpu_engine_args" if use_gpu else "engine_args"]
    argv = [sys.executable, "-B", "-s", "-m", "packages.md_run", "--job-bundle", str(bundle),
            "--engine", executable, "--output-dir", str(directory / "run")]
    argv.extend("--engine-arg=" + flag for flag in flags)
    if restart := dispatch["restart"]:
        previous = _safe(_PLAN_ID, restart["plan_id"], "restart plan ID")
        _safe(_JOB_ID, restart["job_id"], "restart job ID")
        checkpoint = restart["checkpoint"]
        if checkpoint != "final.restart":
            _safe(_CHECKPOINT, checkpoint, "checkpoint")
        md_job._int(restart["steps"], "additional steps", 2**31 - 1)
        argv.extend(("--checkpoint", str(directory.parent / previous / "run" / checkpoint),
                     "--restart-provenance", json.dumps(restart, separators=(",", ":"))))
    libraries = shlex.quote(":".join(profile["library_path"]))
    return ("#!/bin/sh\nset -eu\numask 077\n"
            "export PATH=/usr/bin:/bin LC_ALL=C PYTHONNOUSERSITE=1\n"
            f"export LD_LIBRARY_PATH={libraries} OMP_NUM_THREADS={resources['cpus']} OPENBLAS_NUM_THREADS=1\n"
            f"cd {shlex.quote(str(_ROOT))}\nexec {shlex.join(argv)}\n")


class _Controller:
    def __init__(self, data_dir, profile):
        self.data_dir, self.profile = data_dir, profile

    def submit(self, directory, plan_id):
        # Claim dispatch before contacting Slurm. A lost reply stays claimed.
        with _locked(directory):
            receipt = directory / "submitted"
            if receipt.exists():
                return _safe(_JOB_ID, _read_private(receipt).strip(), "receipt job ID")
            claim = directory / "dispatch.claimed"
            try:
                fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError as error:
                raise SchedulerUnavailable("Submission already claimed; reconcile its receipt") from error
            with os.fdopen(fd, "w") as stream:
                stream.write(plan_id + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            dispatch = json.loads(_read_private(directory / "dispatch.json"))
            profile = self.profile
            gpu = dispatch["gpus"]
            flags = ["--gres=gpu:v100:1"] if gpu else []
            if profile["memory"] is not None:
                flags.append(f"--mem={profile['memory']}")
            result = _controller(
                "sbatch", "--parsable", "--export=NIL", "--no-requeue", "--nodes=1", "--ntasks=1",
                f"--partition={profile['gpu_partition' if gpu else 'cpu_partition']}",
                f"--nodelist={profile['node']}", f"--cpus-per-task={dispatch['cpus']}",
                f"--time={dispatch['minutes']}", f"--job-name={plan_id}", f"--chdir={directory}",
                "--output=slurm-%j.out", "--error=slurm-%j.err", *flags,
                cwd=directory, input=_script(directory, profile, dispatch),
            )
            match = re.fullmatch(r"([1-9][0-9]*)(?:;[A-Za-z0-9_.-]+)?", result.stdout.strip())
            if result.returncode or match is None:
                raise SchedulerUnavailable("sbatch receipt unavailable: " + result.stderr.strip()[:400])
            job = match[1]
            _atomic_write(receipt, job + "\n")
            return job

    def lookup(self, directory, plan_id):
        try:
            return _safe(_JOB_ID, _read_private(directory / "submitted").strip(), "receipt job ID")
        except FileNotFoundError:
            pass
        result = _controller("scontrol", "-o", "show", "job")
        if result.returncode:
            raise SchedulerUnavailable("Unable to query Slurm for the plan")
        matches = {job["JobId"] for job in _jobs(result.stdout) if job.get("JobName") == plan_id}
        try:
            runner_id = json.loads(_read_private(directory / "run" / "run.json")).get("slurm_job_id")
        except FileNotFoundError:
            runner_id = None
        if isinstance(runner_id, str) and _JOB_ID.fullmatch(runner_id):
            matches.add(runner_id)
        if len(matches) > 1:
            raise SchedulerUnavailable("Conflicting scheduler receipts for this MD plan")
        if matches:
            job_id = matches.pop()
            _atomic_write(directory / "submitted", job_id + "\n")
            return job_id
        return None

    def status(self, directory, plan_id, job_id):
        cache = directory / ("terminal-" + job_id + ".json")
        try:
            return json.loads(_read_private(cache))
        except FileNotFoundError:
            pass
        result = _controller("scontrol", "-o", "show", "job", job_id)
        for job in _jobs(result.stdout):
            if job["JobId"] == job_id and job.get("JobName") == plan_id:
                state, reason = job.get("JobState"), job.get("Reason")
                if state in _TERMINAL:
                    _atomic_write(cache, json.dumps([state, reason]))
                return state, reason
        return None, "No matching Slurm controller record"

    def cancel(self, directory, plan_id, job_id):
        state, _ = self.status(directory, plan_id, job_id)
        if state in _TERMINAL or state == "COMPLETING":
            return
        if state is None:
            raise SchedulerUnavailable("Cannot cancel without a matching Slurm controller record")
        result = _controller("scancel", "--name=" + plan_id, job_id)
        if result.returncode and self.status(directory, plan_id, job_id)[0] not in _TERMINAL:
            raise SchedulerUnavailable("scancel failed: " + result.stderr.strip()[:400])

    def dispatch(self, operation, project, plan_id, job_id=None):
        directory = _check_path(_spool(self.data_dir, project) / _safe(_PLAN_ID, plan_id, "plan ID"))
        if operation == "submit" and job_id is None:
            return self.submit(directory, plan_id)
        if operation == "lookup" and job_id is None:
            return self.lookup(directory, plan_id)
        job_id = _safe(_JOB_ID, job_id, "job ID")
        if operation == "status":
            return self.status(directory, plan_id, job_id)
        if operation == "cancel":
            return self.cancel(directory, plan_id, job_id)
        raise ValueError("Unsupported Slurm broker operation")


class SlurmBroker:
    """Start before managed seccomp. The filtered HTTP process keeps only pipes."""

    def __init__(self, data_dir, config_path):
        self.profile = _profile(json.loads(Path(config_path).read_text(encoding="utf-8")))
        for command in ("sbatch", "scontrol", "scancel"):
            if not shutil.which(command, path="/usr/bin:/bin"):
                raise ValueError(f"Missing Slurm command: {command}")
        self._lock = Lock()
        self._process = subprocess.Popen(
            [sys.executable, "-B", "-s", "-m", "packages.agent.md_slurm", str(data_dir)],
            cwd=_ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            encoding="utf-8", text=True, bufsize=1,
        )
        try:
            self._process.stdin.write(json.dumps(self.profile) + "\n")
            self._process.stdin.flush()
            if self._process.stdout.readline() != "ready\n":
                raise SchedulerUnavailable("Slurm broker did not start")
        except BaseException:
            self.close()
            raise

    def call(self, *args):
        process = self._process
        with self._lock:
            try:
                process.stdin.write(json.dumps(args) + "\n")
                process.stdin.flush()
                reply = process.stdout.readline()
            except (OSError, ValueError) as error:
                raise SchedulerUnavailable("Slurm broker is unavailable") from error
            if not reply:
                raise SchedulerUnavailable("Slurm broker stopped")
            result = json.loads(reply)
        if "error" in result:
            raise SchedulerUnavailable(result["error"])
        return result["value"]

    def close(self):
        self._process.stdin.close()
        try:
            self._process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            self._process.wait(timeout=4)
        finally:
            self._process.stdout.close()


def _broker_main():
    controller = _Controller(Path(sys.argv[1]), json.loads(sys.stdin.readline()))
    print("ready", flush=True)
    for line in sys.stdin:
        try:
            args = json.loads(line)
            if not isinstance(args, list) or len(args) not in (3, 4):
                raise ValueError("Invalid Slurm broker request")
            result = {"value": controller.dispatch(*args)}
        except (OSError, ValueError, KeyError, TypeError, SchedulerUnavailable) as error:
            result = {"error": str(error)[:800]}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    _broker_main()
