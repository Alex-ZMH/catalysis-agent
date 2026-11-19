"""Disk-backed, project-local analysis records with atomic publication."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from packages.check import OPERATIONS as BASE_OPERATIONS

OPERATIONS = {**BASE_OPERATIONS, "md_thermo": "md.thermo", "md_msd": "md.msd", "md_transport": "md.transport"}


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


_TRANSPORT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}")


def _transport_external_id(value, label):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise ValueError(f"输运来源缺少有效的 {label}。")
    value = str(value)
    if not _TRANSPORT_ID.fullmatch(value):
        raise ValueError(f"输运来源的 {label} 不是安全的 Slurm 标识。")
    return value


def _transport_metadata(files):
    metadata_pair = next((pair for role, pair in files.items() if role in {"metadata", "provenance"}), None)
    if metadata_pair is None:
        raise ValueError("MD 输运导入需要 transport_metadata。")
    try:
        metadata = json.loads(metadata_pair[1].decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("输运元数据必须是合法的 JSON 对象。") from error
    if not isinstance(metadata, dict):
        raise ValueError("输运元数据必须是 JSON 对象。")
    containers = [metadata]
    for key in ("provenance", "execution", "source", "transport"):
        if isinstance(metadata.get(key), dict):
            containers.append(metadata[key])

    def identity(keys, label):
        values = [_transport_external_id(container[key], label)
                  for container in containers for key in keys if key in container]
        if not values:
            return None
        if any(value != values[0] for value in values[1:]):
            raise ValueError(f"输运来源的 {label} 在元数据中不一致。")
        return values[0]

    plan_id = identity(("plan_id", "source_plan_id"), "plan ID")
    job_id = identity(("job_id", "scheduler_job_id", "slurm_job_id", "source_job_id"), "job ID")
    if plan_id is None or job_id is None:
        raise ValueError("输运元数据必须包含实际 plan_id 和 job_id。")
    names = []
    for container in containers:
        values = container.get("source_files", container.get("source_paths"))
        if isinstance(values, dict):
            values = list(values.values())
        if values is None:
            continue
        if not isinstance(values, list):
            raise ValueError("输运元数据的原始文件清单无效。")
        for item in values:
            if isinstance(item, dict):
                item = item.get("filename", item.get("name", item.get("path")))
            if not isinstance(item, str) or not item.strip():
                raise ValueError("输运元数据的原始文件清单无效。")
            names.append(Path(item.replace("\\", "/")).name)
    uploaded = {pair[0] for pair in files.values()}
    missing = sorted(set(names) - uploaded)
    if missing:
        raise ValueError(f"输运元数据引用的原始文件未随请求上传：{missing[0]}")
    return metadata, {"plan_id": plan_id, "job_id": job_id,
                      "source_files": sorted(uploaded | set(names)), "verified": False}


def read_transport_metadata(files):
    """Parse transport provenance without assigning trust to its claims."""
    return _transport_metadata(files)


def build_transport_inputs(filename, content, options, transport_files=None):
    """Normalize the primary transport file and optional raw sidecars."""
    inputs = {}
    primary_role = options.get("transport_primary_role", "profile")
    primary_role = "global_flux" if primary_role == "global" else primary_role
    if primary_role not in {"profile", "global_flux"}:
        raise ValueError("输运主文件必须是 profile 或 global_flux。")
    inputs[primary_role] = (filename, content)
    for key in sorted(transport_files or {}):
        pair = transport_files[key]
        role = key.removeprefix("transport_")
        role = "global_flux" if role == "global" else role
        if role in inputs:
            if inputs[role] != pair:
                raise ValueError(f"输运 {role} 原始文件重复且内容不同。")
            continue
        inputs[role] = pair
    return inputs


def _transport_candidate(options, fields, keys, label):
    values = []
    for container in (options, fields or {}):
        for key in keys:
            if key in container and container[key] not in (None, ""):
                values.append(_transport_external_id(container[key], label))
    return values[0] if values else None


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
        self.base = base
        self.runs, self.blobs = base / "runs", base / "raw"
        self.runs.mkdir(parents=True, exist_ok=True)
        self.blobs.mkdir(parents=True, exist_ok=True)

    def _store(self, sha, content):
        dest = self.blobs / sha[:2] / sha
        dest.parent.mkdir(exist_ok=True)
        if dest.is_file():
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
        finally:
            temp_name.unlink(missing_ok=True)

    def analyze(self, kind, filename, content, options, origin, reference=None,
                transport_files=None, transport_fields=None, transport_verification=None):
        if kind not in OPERATIONS or origin not in {"synthetic", "research"}:
            raise ValueError("请选择分析类型和数据来源。")
        if not isinstance(options, dict) or not content:
            raise ValueError("请提供非空文件和 JSON 对象形式的参数。")
        transport_mode = kind == "md_transport"
        if transport_files and not transport_mode:
            raise ValueError("输运原始文件只能用于 MD 输运导入。")
        transport_inputs = (build_transport_inputs(filename, content, options, transport_files)
                            if transport_mode else {})
        importing = kind in {"md", "equipment"}
        uploads = [(filename, content)]
        if transport_mode:
            uploads.extend(pair for pair in transport_inputs.values() if pair not in uploads)
        if reference is not None:
            if not importing:
                raise ValueError("只有轨迹与设备场导入接受独立参考文件。")
            if not reference[1] or reference[1] == content:
                reference = None
            else:
                uploads.append(reference)
        for name, data in uploads:
            if not name or len(name) > 255 or any(ord(c) < 32 or c in "/\\" for c in name):
                raise ValueError("上传文件名无效。")
            if not data:
                raise ValueError("上传文件为空。")
        config = dict(kind=kind, options=options, origin=origin)
        source_key = digest(content)
        transport_checksums = {role: (source_key if data is content else digest(data))
                               for role, (name, data) in transport_inputs.items()}
        transport_keys = [(role, transport_inputs[role][0], transport_checksums[role])
                          for role in sorted(transport_inputs)]
        if reference is not None:
            config["reference"] = {"filename": reference[0], "sha256": digest(reference[1])}
        run_id = "run-" + digest(json_bytes([self.project, self.operator, self.commit,
                                            filename, source_key, transport_keys, config]))
        if (self.runs / run_id).exists():
            return self.detail(run_id)
        records, names, contents = {}, {}, {}

        def add(name, data, role, parents=(), *, checksum=None):
            checksum = checksum or digest(data)
            artifact = "art-" + digest(json_bytes([name, role, checksum, parents]))
            fmt = Path(name).suffix.lstrip(".").lower()
            records[artifact] = dict(artifact_id=artifact, project_id=self.project, role=role,
                                     sha256=checksum, size_bytes=len(data), origin=origin,
                                     format=fmt if re.fullmatch("[a-z0-9]{1,16}", fmt) else "binary",
                                     parents=list(parents))
            names[artifact], contents[checksum] = name, data
            return artifact

        raw_ids = {}
        if transport_mode:
            for role, (name, data) in transport_inputs.items():
                raw_ids[role] = add(name, data, "source", checksum=transport_checksums[role])
            primary_role = next(role for role, pair in transport_inputs.items() if pair == (filename, content))
            raw_id = raw_ids[primary_role]
        else:
            raw_id = add(filename, content, "source", checksum=source_key)

        def register(name, data):
            return add(name, data, "derived", [raw_id])

        ref_id = None
        execution = None
        if kind in {"md_thermo", "md_msd", "md_transport"}:
            from packages.science.md_analysis import analyze_thermo, analyze_msd
            from packages.science.md_transport import analyze_transport
            analyzer = {"md_thermo": analyze_thermo, "md_msd": analyze_msd,
                        "md_transport": analyze_transport}[kind]
            analysis_name, analysis_content = filename, content
            analysis_options = dict(options)
            paired_transport = transport_mode and (
                len(transport_inputs) > 1 or transport_verification is not None
            )
            if transport_mode:
                if not paired_transport:
                    metadata, execution = None, None
                elif transport_verification is None:
                    if "metadata" not in transport_inputs and "provenance" not in transport_inputs:
                        raise ValueError("成对 MD 输运原始文件需要 transport_metadata。")
                    metadata, execution = _transport_metadata(transport_inputs)
                else:
                    if (not isinstance(transport_verification, dict)
                            or not isinstance(transport_verification.get("metadata"), dict)
                            or not isinstance(transport_verification.get("execution"), dict)):
                        raise ValueError("输运来源核验上下文无效。")
                    metadata = transport_verification["metadata"]
                    execution = dict(transport_verification["execution"])
                if paired_transport:
                    submitted_plan = _transport_candidate(
                        options, transport_fields, ("source_plan_id", "transport_plan_id", "plan_id"), "plan ID")
                    submitted_job = _transport_candidate(
                        options, transport_fields, ("source_job_id", "transport_job_id", "job_id"), "job ID")
                    if submitted_plan is not None and submitted_plan != execution["plan_id"]:
                        raise ValueError("提交的 plan ID 与输运元数据不一致。")
                    if submitted_job is not None and submitted_job != execution["job_id"]:
                        raise ValueError("提交的 job ID 与输运元数据不一致。")
                    for key in ("source_plan_id", "transport_plan_id", "plan_id",
                                "transport_job_id", "job_id"):
                        analysis_options.pop(key, None)
                    analysis_options["source_job_id"] = execution["job_id"]
            analysis_options.pop("transport_primary_role", None)
            if not paired_transport:
                analysis_options.pop("source_plan_id", None)
                analysis_options.pop("transport_plan_id", None)
                analysis_options.pop("plan_id", None)
                analysis_options.pop("transport_job_id", None)
                analysis_options.pop("job_id", None)
                analysis_options.pop("field_source", None)
            if paired_transport:
                from packages.science.md_transport import analyze_transport_sources
                source_payload = {role: (pair[0], pair[1], raw_ids[role])
                                  for role, pair in transport_inputs.items()}
                result = analyze_transport_sources(source_payload, analysis_options)
            else:
                result = analyzer(analysis_name, analysis_content, analysis_options)
            if paired_transport:
                source = dict(result.get("source") or {})
                source.update(plan_id=execution["plan_id"], job_id=execution["job_id"],
                              verified=execution["verified"], source_files=execution["source_files"],
                              raw_artifact_ids=raw_ids)
                result["source"] = source
            normalized = config
            details = {"raw_artifact_id": raw_id, "parameters": analysis_options,
                       "source_job_id": analysis_options.get("source_job_id"),
                       "analysis": "direct-output"}
            if paired_transport:
                details["transport"] = {"metadata": metadata, "provenance": execution,
                                         "source_artifacts": raw_ids}
            input_ids = list(raw_ids.values()) if transport_mode else [raw_id]
        elif importing:
            from packages.science import field_probe, lammps
            reference_input = None
            input_ids = [raw_id]
            if reference is not None:
                ref_name, ref_bytes = reference
                ref_id = add(ref_name, ref_bytes, "source", checksum=config["reference"]["sha256"])
                input_ids.append(ref_id)
                reference_input = (ref_name, ref_bytes, ref_id)
            reader = lammps if kind == "md" else field_probe
            result, details = reader.read_import(filename, content, options, raw_id, reference_input)
        else:
            from packages.science import fit, vasp
            adapter = vasp if kind == "adsorption" else fit
            normalized, result, details = adapter.analyze(filename, content, options, origin, raw_id, register)
            input_ids = [add("normalized.json", json_bytes(normalized), "derived", sorted(records))]
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
                quality = "review"
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        manifest = dict(schema_version="1.0.0", project_id=self.project, run_id=run_id,
                        operator_id=self.operator, recorded_at=now, operation=OPERATIONS[kind],
                        method={"id": kind, "version": "0.1.0"}, code_commit=self.commit,
                        profile="intranet-v1", parameters_artifact=cfg_id, inputs=input_ids,
                        outputs=[out_id, detail_id], artifacts=list(records.values()),
                        quality=quality, quality_flags=sorted(flags))
        if execution is not None:
            manifest["execution"] = {"runner": "slurm", **execution,
                                     "sources": [{"artifact_id": raw_ids[role], "name": pair[0], "role": role}
                                                 for role, pair in transport_inputs.items()]}
        summary = dict(id=run_id, kind=kind, origin=origin, created_at=now, filename=filename)
        if execution is not None:
            summary["mode"] = "transport"
            summary["execution"] = manifest["execution"]
        index = dict(names=names, raw=raw_id, input=cfg_id if importing or kind in {"md_thermo", "md_msd", "md_transport"} else input_ids[0],
                     result=out_id, details=detail_id)
        if transport_mode:
            index["raw_ids"] = raw_ids
        if ref_id is not None:
            index["reference_id"] = ref_id
        # Publish the complete run after all referenced blobs have been stored.
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
        return self._view(summary, manifest, index,
                          {"input": config if importing else normalized, "result": result, "details": details})

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
        return (self.blobs / sha[:2] / sha).read_bytes()

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
        records = {a["artifact_id"]: a for a in manifest["artifacts"]}
        values = {name: json.loads(self._bytes(records[index[name]]))
                  for name in ("input", "result", "details")}
        return self._view(summary, manifest, index, values)

    @staticmethod
    def _view(summary, manifest, index, values):
        base = "/api/runs/" + summary["id"]
        public = []
        records = {a["artifact_id"]: a for a in manifest["artifacts"]}
        for key, record in records.items():
            public.append(dict(id=key, name=index["names"][key], role=record["role"],
                               size_bytes=record["size_bytes"], sha256=record["sha256"],
                               parents=record["parents"], url=f"{base}/artifacts/{key}"))
        view = dict(**summary, **values, artifacts=public, raw_id=index["raw"],
                    raw_ids=index.get("raw_ids", {"primary": index["raw"]}),
                    reference_id=index.get("reference_id"),
                    manifest_url=base + "/manifest", quality=manifest["quality"],
                    quality_flags=manifest["quality_flags"])
        view["execution"] = manifest.get("execution")
        return view
