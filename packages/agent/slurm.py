"""Submit and recover the fixed A6 synthetic GPU probe."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
from tempfile import NamedTemporaryFile


_PLAN_ID = re.compile(r"plan-[0-9a-f]{64}")
_JOB_ID = re.compile(r"[1-9][0-9]*")
_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
_SPEC_FIELDS = {
    "run_id", "run_kind", "origin", "source_name", "source_sha256", "source_id",
    "source_commit", "workflow", "cpus", "gpus", "minutes", "mode", "policy_id",
}

_PROBE = r"""import ctypes as c
import json
import os
import re
import sys
from tempfile import NamedTemporaryFile

plan_id, digest, marker = sys.argv[1:]
job_id = os.environ["SLURM_JOB_ID"]
if not re.fullmatch(r"[1-9][0-9]*", job_id) or not os.environ.get("CUDA_VISIBLE_DEVICES"):
    raise RuntimeError("Expected a Slurm GPU allocation")

cuda = c.CDLL("libcuda.so.1")


def call(name, *args):
    status = getattr(cuda, name)(*args)
    if status:
        raise RuntimeError(f"{name} failed with CUDA status {status}")


ptx = b'''
.version 6.0
.target sm_70
.address_size 64

.visible .entry probe(.param .u64 result) {
    .reg .u64 %address;
    .reg .u32 %thread, %value;
    ld.param.u64 %address, [result];
    mov.u32 %thread, %tid.x;
    mad.lo.u32 %value, %thread, %thread, 7;
    mad.wide.u32 %address, %thread, 4, %address;
    st.global.u32 [%address], %value;
    ret;
}
'''
count, dev = c.c_int(), c.c_int()
name = c.create_string_buffer(128)
call("cuInit", 0)
call("cuDeviceGetCount", c.byref(count))
if count.value != 1:
    raise RuntimeError("Expected exactly one visible CUDA device")
call("cuDeviceGet", c.byref(dev), 0)
call("cuDeviceGetName", name, len(name), dev)
device = name.value.decode()
if "V100" not in device:
    raise RuntimeError(f"Expected V100, got {device}")

context, module, kernel = c.c_void_p(), c.c_void_p(), c.c_void_p()
buffer = c.c_uint64()
values = (c.c_uint32 * 32)()
call("cuCtxCreate_v2", c.byref(context), 0, dev)
try:
    call("cuModuleLoadData", c.byref(module), ptx)
    call("cuModuleGetFunction", c.byref(kernel), module, b"probe")
    call("cuMemAlloc_v2", c.byref(buffer), c.c_size_t(c.sizeof(values)))
    args = (c.c_void_p * 1)(c.addressof(buffer))
    call("cuLaunchKernel", kernel, 1, 1, 1, len(values), 1, 1, 0, None, args, None)
    call("cuMemcpyDtoH_v2", values, buffer, c.c_size_t(c.sizeof(values)))
finally:
    call("cuCtxDestroy_v2", context)
if list(values) != [i * i + 7 for i in range(len(values))]:
    raise RuntimeError("GPU result mismatch")

receipt = dict(plan_id=plan_id, digest=digest, marker=marker, job_id=job_id,
               uid=os.getuid(), device=device, values=list(values))
with NamedTemporaryFile(mode="w", dir=".", delete=False) as output:
    temporary = output.name
    try:
        json.dump(receipt, output)
        output.flush()
        os.fsync(output.fileno())
        os.replace(temporary, f"result-{job_id}.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
"""


def _validate(plan):
    plan_id, digest, spec = plan["id"], plan["digest"], plan["spec"]
    if not isinstance(plan_id, str) or not _PLAN_ID.fullmatch(plan_id):
        raise ValueError("Invalid plan ID")
    if digest != plan_id[5:]:
        raise ValueError("Invalid plan digest")
    if not isinstance(spec, dict) or spec.keys() != _SPEC_FIELDS:
        raise ValueError("Unexpected synthetic plan fields")
    if (spec["workflow"], spec["origin"], spec["mode"], spec["policy_id"]) != (
        "synthetic-v100", "synthetic", "slurm-synthetic", "a6-synthetic-v100-v1"
    ):
        raise ValueError("Only synthetic-v100 Slurm plans are supported")
    run_id = spec["run_id"]
    if not isinstance(run_id, str) or not re.fullmatch(r"run-[0-9a-f]{64}", run_id):
        raise ValueError("Invalid run ID")
    name = spec["source_name"]
    if (not isinstance(name, str) or not name or name in {".", ".."}
            or "/" in name or "\\" in name or any(ord(c) < 32 for c in name)):
        raise ValueError("Expected a source display name, without a path")
    for key, allowed in (("cpus", (1, 2)), ("gpus", (1,)), ("minutes", (1, 2))):
        if type(spec[key]) is not int or spec[key] not in allowed:
            raise ValueError(f"Invalid synthetic plan resource: {key}")
    return plan_id, digest, spec["cpus"], spec["minutes"]


def _private_dir(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError(f"Unsafe Slurm directory: {path}")


def _read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError(f"Unsafe Slurm file: {path.name}")
        return stream.read()


def _check_receipt(record, path, plan_id, digest, job_id, result, *, archived=False):
    if not isinstance(record, dict) or type(record.get("uid")) is not int or record["uid"] < 0:
        raise RuntimeError(f"Invalid Slurm receipt owner: {path.name}")
    expected = dict(plan_id=plan_id, digest=digest, marker=plan_id, job_id=job_id)
    if not archived:
        expected["uid"] = os.getuid()
    if any(record.get(k) != v for k, v in expected.items()):
        raise RuntimeError(f"Invalid Slurm receipt: {path.name}")
    if result and (
        not isinstance(record.get("device"), str) or "V100" not in record["device"]
        or record.get("values") != [i * i + 7 for i in range(32)]
    ):
        raise RuntimeError(f"Invalid GPU result: {path.name}")


def _atomic_write(path, content):
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def _slurm(*args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, env=_ENV, timeout=20, **kwargs)


def _script(plan_id, digest):
    return (f"#!/bin/sh\nset -eu\numask 077\n"
            f"export CUDA_CACHE_DISABLE=1\n"
            f"/usr/bin/python3 -I -B - {plan_id} {digest} {plan_id} <<'PYTHON'\n"
            f"{_PROBE}PYTHON\n")


class SyntheticSlurm:
    def __init__(self, directory):
        self.directory = Path(directory).absolute()

    def _directory(self, plan_id, *, create=False):
        root = self.directory
        if root.resolve() != root or any(ord(c) < 32 or c == "%" for c in str(root)):
            raise ValueError("Unsafe Slurm project path")
        directory = root / plan_id
        if create:
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
        elif not root.exists():
            return directory
        _private_dir(root)
        if create:
            directory.mkdir(mode=0o700, exist_ok=True)
        if create or directory.exists() or directory.is_symlink():
            _private_dir(directory)
        return directory

    def prepare(self, plan):
        plan_id, digest, _, _ = _validate(plan)
        for command in ("sbatch", "scontrol", "squeue", "python3"):
            if not shutil.which(command, path=_ENV["PATH"]):
                raise RuntimeError(f"Missing required executable: {command}")
        directory = self._directory(plan_id, create=True)
        script = directory / "synthetic-v100.sh"
        _atomic_write(script, _script(plan_id, digest))
        return script

    def submit(self, plan):
        plan_id, digest, cpus, minutes = _validate(plan)
        directory = self._directory(plan_id)
        script = directory / "synthetic-v100.sh"
        template = _script(plan_id, digest)
        if _read_private(script) != template:
            raise ValueError("Prepared Slurm script does not match the approved template")
        # Send the fixed template on stdin, so saved script edits cannot affect submission.
        result = _slurm(
            "sbatch", "--parsable", "--partition=gpu", "--gres=gpu:v100:1",
            "--nodes=1", "--ntasks=1", f"--cpus-per-task={cpus}", f"--time={minutes}",
            "--export=NIL", "--no-requeue", f"--job-name={plan_id}", f"--chdir={directory}",
            "--output=slurm-%j.out", "--error=slurm-%j.err",
            cwd=directory, input=template,
        )
        if result.returncode:
            raise RuntimeError(f"sbatch failed: {result.stderr.strip()}")
        match = re.fullmatch(r"([1-9][0-9]*)(?:;[A-Za-z0-9_.-]+)?", result.stdout.strip())
        if not match:
            raise RuntimeError("sbatch returned an invalid job ID")
        job_id = match[1]
        receipt = dict(plan_id=plan_id, digest=digest, marker=plan_id, uid=os.getuid(), job_id=job_id)
        _atomic_write(directory / f"submitted-{job_id}.json", json.dumps(receipt))
        return job_id

    def result_path(self, plan):
        plan_id, _, _, _ = _validate(plan)
        job_id = plan.get("job_id")
        if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            raise FileNotFoundError("No recorded Slurm job")
        return self._directory(plan_id) / f"result-{job_id}.json"

    def result_receipt(self, plan, *, archived=False):
        path = self.result_path(plan)
        content = _read_private(path)
        _check_receipt(json.loads(content), path, plan["id"], plan["digest"], plan["job_id"], True, archived=archived)
        return path.name, content.encode("utf-8")

    def lookup(self, plan):
        plan_id, digest, _, _ = _validate(plan)
        directory = self._directory(plan_id)
        uid = str(os.getuid())
        receipts = set()
        for path in directory.glob("*.json"):
            match = re.fullmatch(r"(submitted|result)-([1-9][0-9]*)\.json", path.name)
            if not match:
                continue
            record = json.loads(_read_private(path))
            _check_receipt(record, path, plan_id, digest, match[2], match[1] == "result")
            receipts.add(match[2])

        matches = set()
        seen = {}
        successes = 0
        for args in (("scontrol", "-o", "show", "job"),
                     ("squeue", "--all", "--local", "--noheader", "--format=%i|%j|%U")):
            try:
                result = _slurm(*args)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode:
                continue
            successes += 1
            for line in result.stdout.splitlines():
                if args[0] == "scontrol":
                    job = re.match(r"JobId=(\S+) JobName=(\S+)\s+UserId=\S+\(([0-9]+)\)", line)
                    if not job:
                        continue
                    job_id, marker, owner = job.groups()
                else:
                    fields = line.strip().split("|")
                    if len(fields) != 3:
                        continue
                    job_id, marker, owner = fields
                if not _JOB_ID.fullmatch(job_id):
                    continue
                seen.setdefault(job_id, set()).add((marker, owner))
                if (marker, owner) == (plan_id, uid):
                    matches.add(job_id)
        if not successes:
            raise RuntimeError("Unable to query Slurm for the synthetic plan")
        candidates = matches | receipts
        if len(candidates) > 1 or any(
            seen.get(job_id, {(plan_id, uid)}) != {(plan_id, uid)} for job_id in candidates
        ):
            raise RuntimeError("Conflicting Slurm jobs or receipts for the synthetic plan")
        return next(iter(candidates), None)
