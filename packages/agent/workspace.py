"""Disk-backed, project-local analysis records with atomic publication."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from packages.agent.records import verify_blob
from packages.check import OPERATIONS, link_result
from packages.science import adsorption, kinetics


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Workspace:
    def __init__(self, data_dir, project, operator, commit):
        for name in (project, operator):
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}", name):
                raise ValueError("Invalid project or operator ID")
        data_dir = Path(data_dir).resolve()
        if any((p / ".git").exists() for p in (data_dir, *data_dir.parents)):
            raise ValueError("Select a data directory outside all Git worktrees")
        self.project, self.operator, self.commit = project, operator, commit
        base = data_dir / "projects" / project
        self.runs, self.blobs = base / "runs", base / "raw"
        self.runs.mkdir(parents=True, exist_ok=True)
        self.blobs.mkdir(parents=True, exist_ok=True)

    def _store(self, sha, content):
        dest = self.blobs / sha[:2] / sha
        dest.parent.mkdir(exist_ok=True)
        if dest.exists():
            with dest.open("rb") as stream:
                verify_blob({"sha256": sha, "size_bytes": len(content)}, stream)
            return
        with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as temp:
            temp_name = Path(temp.name)
            try:
                temp.write(content)
                temp.flush()
                os.fsync(temp.fileno())
            except BaseException:
                temp.close()
                temp_name.unlink(missing_ok=True)
                raise
        try:
            # Concurrent writers for the same SHA publish identical complete bytes.
            try:
                os.replace(temp_name, dest)
            except PermissionError:
                # Windows may retain a read handle after another writer published first.
                if not dest.is_file():
                    raise
                with dest.open("rb") as stream:
                    verify_blob({"sha256": sha, "size_bytes": len(content)}, stream)
        finally:
            temp_name.unlink(missing_ok=True)

    def analyze(self, kind, filename, content, options, origin, reference=None):
        if kind not in OPERATIONS or origin not in {"synthetic", "research"}:
            raise ValueError("请选择分析类型和数据来源。")
        if not isinstance(options, dict) or not content:
            raise ValueError("请提供非空文件和 JSON 对象形式的参数。")
        importing = kind in {"md", "equipment"}
        uploads = [(filename, content)]
        if reference is not None:
            if not importing:
                raise ValueError("只有轨迹与设备场导入接受独立参考文件。")
            uploads.append(reference)
        for name, data in uploads:
            if not name or len(name) > 255 or any(ord(c) < 32 or c in "/\\" for c in name):
                raise ValueError("上传文件名无效。")
            if not data:
                raise ValueError("上传文件为空。")
        config = dict(kind=kind, options=options, origin=origin)
        if reference is not None:
            config["reference"] = {"filename": reference[0], "sha256": digest(reference[1])}
        run_id = "run-" + digest(json_bytes([self.project, self.operator, self.commit,
                                            filename, digest(content), config]))
        if (self.runs / run_id).exists():
            return self.detail(run_id)
        records, names, contents = {}, {}, {}

        def add(name, data, role, parents=()):
            checksum = digest(data)
            artifact = "art-" + digest(json_bytes([name, role, checksum, parents]))
            fmt = Path(name).suffix.lstrip(".").lower()
            records[artifact] = dict(artifact_id=artifact, project_id=self.project, role=role,
                                     sha256=checksum, size_bytes=len(data), origin=origin,
                                     format=fmt if re.fullmatch("[a-z0-9]{1,16}", fmt) else "binary",
                                     parents=list(parents))
            names[artifact], contents[checksum] = name, data
            return artifact

        raw_id = add(filename, content, "source")

        def register(name, data):
            return add(name, data, "derived", [raw_id])

        normalized = normalized_bytes = None
        ref_id = None
        if importing:
            from packages.science import field_probe, lammps
            reference_input = None
            input_ids = [raw_id]
            if reference is not None:
                ref_name, ref_bytes = reference
                if ref_bytes == content:
                    raise ValueError("参考文件必须独立于数据文件。")
                ref_id = add(ref_name, ref_bytes, "source")
                input_ids.append(ref_id)
                reference_input = (ref_name, ref_bytes, ref_id)
            reader = lammps if kind == "md" else field_probe
            result, details = reader.read_import(filename, content, options, raw_id, reference_input)
        else:
            from packages.science import fit, vasp
            adapter = vasp if kind == "adsorption" else fit
            normalized, result, details = adapter.analyze(filename, content, options, origin, raw_id, register)
            validator = adsorption if kind == "adsorption" else kinetics
            validator.validate_result(result, normalized)
            normalized_bytes = json_bytes(normalized)
            input_ids = [add("normalized.json", normalized_bytes, "derived", sorted(records))]
        cfg_id = add("parameters.json", json_bytes(config), "parameters")
        result_bytes = json_bytes(result)
        parents = [*input_ids, cfg_id]
        out_id = add("result.json", result_bytes, "derived", parents)
        detail_id = add("details.json", json_bytes(details), "derived", parents)
        flags = set(result.get("warnings", []))
        quality = "review" if flags else "accepted"
        if kind == "adsorption":
            rows = result["results"]
            rejected = [row for row in rows if row["status"] == "noncomparable"]
            flags.update(reason for row in rejected for reason in row["reasons"])
            if rejected:
                quality = "blocked" if len(rejected) == len(rows) else "review"
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        manifest = dict(schema_version="1.0.0", project_id=self.project, run_id=run_id,
                        operator_id=self.operator, recorded_at=now, operation=OPERATIONS[kind],
                        method={"id": kind, "version": "0.1.0"}, code_commit=self.commit,
                        profile="intranet-v1", parameters_artifact=cfg_id, inputs=input_ids,
                        outputs=[out_id, detail_id], artifacts=list(records.values()),
                        quality=quality, quality_flags=sorted(flags))
        link_result(kind, result, result_bytes, manifest, normalized, normalized_bytes)
        summary = dict(id=run_id, kind=kind, origin=origin, created_at=now, filename=filename)
        index = dict(names=names, raw=raw_id, input=cfg_id if importing else input_ids[0],
                     result=out_id, details=detail_id)
        if ref_id is not None:
            index["reference_id"] = ref_id
        # Publish only after both scientific and provenance checks have succeeded.
        for checksum, data in contents.items():
            self._store(checksum, data)
        with tempfile.TemporaryDirectory(dir=self.runs, prefix=".import-") as tmp:
            stage = Path(tmp) / "completed"
            stage.mkdir()
            for name, value in [("manifest", manifest), ("index", index), ("summary", summary)]:
                (stage / (name + ".json")).write_bytes(json_bytes(value))
            try:
                stage.rename(self.runs / run_id)
            except OSError:
                if not (self.runs / run_id).is_dir():
                    raise
        return self.detail(run_id)

    def _read(self, run_id, name):
        if not re.fullmatch(r"run-[0-9a-f]{64}", run_id):
            raise FileNotFoundError("Unknown run")
        return json.loads((self.runs / run_id / (name + ".json")).read_bytes())

    def recent(self):
        runs = [json.loads(p.read_bytes()) for p in self.runs.glob("run-*/summary.json")]
        return sorted(runs, key=lambda r: r["created_at"], reverse=True)

    def manifest(self, run_id):
        return self._read(run_id, "manifest")

    def _bytes(self, record):
        sha = record["sha256"]
        if not re.fullmatch("[a-f0-9]{64}", sha):
            raise ValueError("Invalid artifact digest")
        raw = (self.blobs / sha[:2] / sha).read_bytes()
        if digest(raw) != sha or len(raw) != record["size_bytes"]:
            raise ValueError("原文件校验失败，请核对存储或恢复备份。")
        return raw

    def plan_source(self, run_id):
        """Read the identity of an existing input without loading large scientific arrays."""
        manifest = self.manifest(run_id)
        summary = self._read(run_id, "summary")
        raw_id = self._read(run_id, "index")["raw"]
        raw = next((r for r in manifest["artifacts"] if r["artifact_id"] == raw_id), None)
        if (manifest["project_id"] != self.project or manifest["run_id"] != run_id
                or summary["id"] != run_id or raw is None or raw["role"] != "source"
                or raw["project_id"] != self.project or raw["origin"] != summary["origin"]):
            raise ValueError("计划来源与项目运行清单不一致。")
        return {"run_id": run_id, "run_kind": summary["kind"], "origin": raw["origin"],
                "source_name": summary["filename"], "source_sha256": raw["sha256"],
                "source_id": raw_id, "source_commit": manifest["code_commit"]}

    def download(self, run_id, artifact_id):
        manifest = self.manifest(run_id)
        record = next((a for a in manifest["artifacts"] if a["artifact_id"] == artifact_id), None)
        if record is None:
            raise FileNotFoundError("Unknown artifact")
        return self._read(run_id, "index")["names"][artifact_id], self._bytes(record)

    def detail(self, run_id):
        summary = self._read(run_id, "summary")
        manifest, index = self.manifest(run_id), self._read(run_id, "index")
        base = "/api/runs/" + run_id
        public = []
        records = {a["artifact_id"]: a for a in manifest["artifacts"]}
        for key, record in records.items():
            public.append(dict(id=key, name=index["names"][key], role=record["role"],
                               size_bytes=record["size_bytes"], sha256=record["sha256"],
                               parents=record["parents"], url=f"{base}/artifacts/{key}"))
        values = {name: json.loads(self._bytes(records[index[name]]))
                  for name in ("input", "result", "details")}
        return dict(**summary, **values, artifacts=public, raw_id=index["raw"],
                    reference_id=index.get("reference_id"),
                    manifest_url=base + "/manifest", quality=manifest["quality"],
                    quality_flags=manifest["quality_flags"])
