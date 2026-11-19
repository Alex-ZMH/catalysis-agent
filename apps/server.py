"""Loopback workbench with an explicitly enabled synthetic Slurm submission profile."""
import argparse
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import mimetypes
import os
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import threading
from urllib.parse import quote, urlsplit
from uuid import uuid4
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

from jsonschema import ValidationError
from packages.agent.approvals import ApprovalStore, RestoredApprovalError
from packages.agent.egress import restrict_egress
from packages.agent.md_slurm import MDSlurm, SchedulerUnavailable, SlurmBroker
from packages.agent.slurm import SyntheticSlurm
from packages.agent.workspace import (Workspace, build_transport_inputs, json_bytes,
                                      read_transport_metadata)
from scripts.frontend_baseline import git as baseline_git

ROOT = Path(__file__).resolve().parents[1]


def static_files():
    archive = baseline_git("archive", "--format=zip", "refs/tags/frontend-baseline-v1")
    with ZipFile(io.BytesIO(archive)) as zipped:
        files = {"/" + p: zipped.read(p) for p in zipped.namelist() if not p.endswith("/")
                 and not p.startswith("tools/")}
    for name in ("analysis.css", "analysis.js"):
        files["/" + name] = (ROOT / "apps" / "web" / name).read_bytes()
    overlay = b'<link rel="stylesheet" href="/analysis.css"><script defer src="/analysis.js"></script>'
    files["/"] = files["/index.html"] = files["/index.html"].replace(b"</head>", overlay + b"</head>")
    return files


def form_fields(headers, data, *, md_job=False):
    content_type = headers.get("Content-Type", "")
    if headers.get_content_type() != "multipart/form-data":
        raise ValueError("请以文件表单上传。")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + data)
    if not message.is_multipart() or message.defects:
        raise ValueError("上传表单不完整。")
    files = ({"file", "potential"} if md_job else {
        "file", "reference", "transport_profile", "transport_global", "transport_metadata",
        "transport_provenance", "transport_plan", "transport_velocity", "transport_trajectory",
    })
    allowed = files | ({"run_id", "artifact_id", "options"} if md_job else {
        "options", "kind", "origin", "transport_plan_id", "transport_job_id",
    })
    result = {}
    for part in message.iter_parts():
        key = part.get_param("name", header="Content-Disposition")
        if (part.is_multipart() or part.defects or part.get_content_disposition() != "form-data"
                or key in result or key not in allowed
                or part.get("Content-Transfer-Encoding") is not None):
            raise ValueError("上传字段无效或重复。")
        value = part.get_payload(decode=True)
        if key in files:
            if not isinstance(value, bytes):
                raise ValueError("上传文件内容无效。")
            result[key] = (part.get_filename() or "", value)
        else:
            if not isinstance(value, bytes):
                raise ValueError("表单字段内容无效。")
            if len(value) > 256 * 1024:
                raise ValueError("配置超过 256 KiB。")
            result[key] = value.decode("utf-8")
    if "file" not in result and not md_job:
        if not (result.get("kind") == "md_transport" and result.get("transport_plan_id")):
            raise ValueError("请选择文件。")
    try:
        result["options"] = json.loads(result.get("options", "{}"))
        if not isinstance(result["options"], dict):
            raise ValueError()
        json_bytes(result["options"])
    except ValueError as exc:
        raise ValueError("分析参数必须是合法的 JSON 对象。") from exc
    return result


PLAN_PATH = re.compile(r"/api/plans/(plan-[0-9a-f]{64})(?:/(confirm|reconcile))?")
MD_PLAN_PATH = re.compile(r"/api/plans/(plan-[0-9a-f]{64})/(status|cancel|restart|artifacts/([A-Za-z0-9][A-Za-z0-9_.-]*))")
PLAN_KINDS = {"vasp-relaxation": "adsorption", "md-simulation": "md",
              "equipment-simulation": "equipment"}


RUN_PATH = re.compile(r"/api/runs/(run-[0-9a-f]{64})(?:/(manifest|artifacts/(art-[0-9a-f]{64})))?")
MD_EXPORT_PATH = re.compile(r"/api/runs/(run-[0-9a-f]{64})/artifacts/(art-[0-9a-f]{64})/md-data")
PROJECT_PATH = re.compile(r"/api/projects/([a-zA-Z0-9][a-zA-Z0-9_-]{0,95})(/.*)")
RECEIPT_PATH = re.compile(r"/api/plans/(plan-[0-9a-f]{64})/receipt")
BACKUP_PATH = re.compile(r"/api/backups/([0-9a-f]{64})")
COOKIE_NAME = "catalysis_session"
ACTIONS = {
    (False, "/api/runs"): "project.runs.list",
    (False, "/api/plans"): "project.plans.list",
    (False, "/api/backups"): "project.backups.list",
    (True, "/api/runs"): "project.run.create",
    (True, "/api/cell"): "project.cell.check",
    (True, "/api/md-handoff"): "project.structure.convert",
    (True, "/api/md-job"): "project.md.prepare",
    (True, "/api/md-job/plan"): "project.md.plan",
    (True, "/api/plans"): "project.plan.create",
}


def access_action(path, post):
    if (post, path) in ACTIONS:
        return ACTIONS[post, path], {}
    if not post and (handoff := MD_EXPORT_PATH.fullmatch(path)):
        return "project.structure.export", {"run_id": handoff[1], "artifact_id": handoff[2]}
    if not post and (run := RUN_PATH.fullmatch(path)):
        run_id, suffix, artifact_id = run.groups()
        ids = {"run_id": run_id}
        if artifact_id:
            return "project.artifact.read", {**ids, "artifact_id": artifact_id}
        return "project.manifest.read" if suffix else "project.run.read", ids
    if (plan := MD_PLAN_PATH.fullmatch(path)) and post == (plan[2] in {"cancel", "restart"}):
        action = "artifact" if plan[3] else plan[2]
        return "project.md." + action, {"plan_id": plan[1]}
    if (plan := PLAN_PATH.fullmatch(path)) and post == bool(plan[2]):
        return "project.plan." + (plan[2] or "read"), {"plan_id": plan[1]}
    if not post and (receipt := RECEIPT_PATH.fullmatch(path)):
        return "project.plan.receipt", {"plan_id": receipt[1]}
    if not post and (backup := BACKUP_PATH.fullmatch(path)):
        return "project.backup.read", {"backup_id": backup[1]}
    return "project.route", {}


def plan_spec(store, body, synthetic_submission):
    if set(body) != {"run_id", "workflow", "cpus", "gpus", "minutes"}:
        raise ValueError("请提供来源运行、工作流、CPU 数量、GPU 数量和时限。")
    if not all(isinstance(body[k], str) for k in ("workflow", "run_id")):
        raise ValueError("无效的工作流或运行标识。")
    workflow = body["workflow"]
    source = store.plan_source(body["run_id"])
    synthetic = workflow == "synthetic-v100"
    if synthetic:
        if not synthetic_submission or source["origin"] != "synthetic":
            raise ValueError("短时 V100 验收需要合成来源和已启用的合成作业配置。")
    elif workflow not in PLAN_KINDS or PLAN_KINDS[workflow] != source["run_kind"]:
        raise ValueError("工作流与来源运行类型不匹配。")
    limits = {"cpus": (1, 2 if synthetic else 256), "gpus": (1, 1) if synthetic else (0, 8),
              "minutes": (1, 2 if synthetic else 10080)}
    for field, (low, high) in limits.items():
        if type(body[field]) is not int or not low <= body[field] <= high:
            raise ValueError(f"{field} 必须是 {low} 到 {high} 之间的整数。")
    return {**source, **body, "mode": "slurm-synthetic" if synthetic else "plan-only",
            "policy_id": "a6-synthetic-v100-v1" if synthetic else "intranet-v1"}


def _transport_plan_outputs(plan):
    """Return output basenames declared by an authorized MD plan."""
    spec = plan.get("spec") if isinstance(plan, dict) else None
    config = spec.get("config") if isinstance(spec, dict) else None
    sampling = config.get("transport_sampling") if isinstance(config, dict) else None
    if not isinstance(sampling, dict) or sampling.get("enabled") is not True:
        return set()
    outputs = sampling.get("outputs")
    if not isinstance(outputs, dict):
        prefix = sampling.get("output_prefix", "transport")
        channels = sampling.get("channels", [])
        fields = sampling.get("fields", [])
        outputs = {"metadata": f"{prefix}_metadata.json"}
        if any(channel != "heat_global" for channel in channels):
            outputs["profile"] = f"{prefix}_profile.dat"
        if "heat_global" in channels:
            outputs["global_flux"] = f"{prefix}_global.dat"
        if "velocity" in fields:
            outputs["velocity"] = f"{prefix}_velocity.dat"
    return {str(name).replace("\\", "/").rsplit("/", 1)[-1]
            for name in outputs.values() if isinstance(name, str) and name}


def _transport_source_roles(inputs):
    return {role: pair for role, pair in inputs.items()
            if role not in {"metadata", "provenance", "plan"}}


def _transport_metadata_driving(sources):
    """Read the native driving block from already-loaded metadata bytes once."""
    pair = sources.get("transport_metadata")
    if pair is None:
        return None
    try:
        metadata = json.loads(pair[1].decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("授权计划 transport_metadata 必须是合法的 JSON 对象。") from error
    if not isinstance(metadata, dict):
        raise ValueError("授权计划 transport_metadata 必须是 JSON 对象。")
    return metadata.get("driving")


def resolve_uploaded_transport(approvals, filename, content, options, transport_files):
    """Parse an uploaded claim, but never promote it to server-verified trust."""
    inputs = build_transport_inputs(filename, content, options, transport_files)
    metadata, claim = read_transport_metadata(inputs)
    execution = dict(claim, verified=False,
                     verification_reason="原始输运文件由请求上传，未由授权计划工件读取")
    # Resolve the project-scoped record when possible so the UI can still show
    # the submitted IDs, but uploaded bytes are never marked as verified.
    try:
        plan = approvals.get(claim["plan_id"]) if approvals is not None else None
    except FileNotFoundError:
        plan = None
    if plan is None:
        execution["verification_reason"] = "输运来源计划不是当前项目的授权记录"
    elif plan.get("job_id") != claim["job_id"]:
        execution["verification_reason"] = "上传声明的 job ID 与授权计划记录不一致"
    return {"metadata": metadata, "execution": execution}


def resolve_plan_transport(approvals, scheduler, plan_id, job_id, options, upload_limit,
                           declared_origin=None):
    """Read native transport outputs from the authorized project's plan spool."""
    if approvals is None or scheduler is None:
        raise ValueError("当前项目未配置可读取 Slurm 工件的计划存储。")
    try:
        plan = approvals.get(plan_id)
    except FileNotFoundError as error:
        raise ValueError("输运来源计划不是当前项目的授权记录。") from error
    spec = plan.get("spec", {})
    if (plan.get("id") != plan_id or plan.get("state") != "submitted"
            or plan.get("job_id") != job_id
            or spec.get("workflow") != "md-lammps" or spec.get("mode") != "slurm-md"):
        raise ValueError("计划 ID、job ID 或计划类型与实际项目记录不一致。")
    plan_origin = spec.get("origin")
    if plan_origin in {"synthetic", "research"}:
        resolved_origin, origin_verified, origin_source = plan_origin, True, "plan"
    elif plan_origin == "unknown":
        if declared_origin not in {"synthetic", "research"}:
            raise ValueError("计划未记录数据来源；请明确声明 synthetic 或 research。")
        resolved_origin, origin_verified, origin_source = declared_origin, False, "user"
    else:
        raise ValueError("授权计划的实际数据来源无效，无法导入项目运行。")
    outputs = _transport_plan_outputs(plan)
    if not outputs:
        raise ValueError("授权计划未声明 transport_sampling 输出。")
    role_by_suffix = {"_profile.dat": "profile", "_global.dat": "global_flux",
                      "_velocity.dat": "velocity", "_metadata.json": "metadata",
                      "-metadata.json": "metadata"}
    sources = {}
    for name in sorted(outputs):
        role = next((suffix_role for suffix, suffix_role in role_by_suffix.items()
                     if name.endswith(suffix)), None)
        if role is None:
            continue
        try:
            stream, size = scheduler.artifact(plan, name)
        except FileNotFoundError:
            continue
        if size <= 0 or size > upload_limit:
            raise ValueError(f"授权计划工件超过导入大小限制：{name}")
        with stream:
            raw = stream.read(size + 1)
        if len(raw) != size:
            raise ValueError(f"授权计划工件读取不完整：{name}")
        sources["transport_" + role] = (name, raw)
    actual = _transport_source_roles({key.removeprefix("transport_"): value
                                      for key, value in sources.items()})
    if not actual:
        raise ValueError("授权计划没有可读取的 transport profile/global 输出。")
    primary_role = "profile" if "profile" in actual else "global_flux"
    normalized_options = dict(options, transport_primary_role=primary_role)
    plan_bytes = json_bytes(plan)
    sources["transport_plan"] = (f"{plan_id}.json", plan_bytes)
    metadata = {"schema": "md_transport.v1", "provenance": {
        "plan_id": plan_id, "job_id": job_id,
        "source_files": sorted(pair[0] for pair in sources.values()
                                if pair[0] != f"{plan_id}.json")}}
    driving = _transport_metadata_driving(sources)
    if driving is not None:
        metadata["driving"] = driving
    source_files = sorted(pair[0] for pair in sources.values())
    execution = {"plan_id": plan_id, "job_id": job_id, "source_files": source_files,
                 "verified": True,
                 "verification_reason": "服务端从当前项目授权计划工件读取",
                 "origin_verified": origin_verified, "origin_source": origin_source}
    return (normalized_options, sources, {"metadata": metadata, "execution": execution}, resolved_origin)


class Handler(BaseHTTPRequestHandler):
    server_version = "CatalysisWorkbench"
    def log_message(self, fmt, *args):
        pass  # User file names, study parameters and requests are not written to access logs.

    def _send(self, status, data, mime="application/json; charset=utf-8", filename=None):
        if self._headers(status, len(data), mime, filename):
            self.wfile.write(data)

    def _headers(self, status, size, mime, filename=None):
        event = getattr(self, "audit_event", None)
        if event is not None:
            try:
                outcome = "allowed" if status < 400 else "denied" if status < 500 else "error"
                self.server.audit.record(dict(event, outcome=outcome, status=status))
            except (OSError, ValueError):
                message = json_bytes({"error": "访问审计暂不可用。"})
                self.send_response(503)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(message)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(message)
                return False
        self.send_response(status)
        if event is not None:
            self.send_header("X-Request-ID", event["request_id"])
        if getattr(self, "session_cookie", None):
            self.send_header("Set-Cookie", self.session_cookie)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                         "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        if filename:
            filename = filename.replace("\\", "/").split("/")[-1]
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(filename, safe=""))
        self.end_headers()
        return True

    def _request(self, post):
        path = urlsplit(self.path).path
        managed = self.server.access is not None
        self.audit_event = self.session_cookie = None
        if managed and (path == "/api" or path.startswith("/api/")):
            self.audit_event = dict(time=datetime.now(timezone.utc).isoformat(),
                                    request_id=uuid4().hex, actor=None, project=None, action="request")
        port = self.server.server_port
        origins = {f"{host}:{port}" for host in ("localhost", "127.0.0.1")}
        if port == 80:
            origins.update({"localhost", "127.0.0.1"})
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if (host not in origins or (origin is not None and origin != "http://" + host)
                or self.headers.get("Sec-Fetch-Site") == "cross-site"):
            self._send(403, json_bytes({"error": "仅接受本机同源访问。"}))
            return
        try:
            if path == "/api/session" and not managed and not post:
                self._send(200, json_bytes({"managed": False, "actor": None, "projects": {}}))
                return
            if managed and getattr(self, "audit_event", None) is not None:
                path = self._managed(path, post)
                if path is None:
                    return
            if managed and path.startswith("/api/"):
                assert_project_layout(self.server.data_dir, self.audit_event["project"])
                self.workspace, self.approvals, self.receipts = project_state(
                    self.server.data_dir, self.audit_event["project"],
                    self.audit_event["actor"], self.server.commit, False, self.server.md_broker
                )
                self.synthetic_submission = False
            else:
                self.workspace = self.server.workspace
                self.approvals = self.server.approvals
                self.receipts = self.server.slurm_receipts
                self.synthetic_submission = self.server.synthetic_submission
            if post:
                self._post(path)
            else:
                self._get(path)
        except SchedulerUnavailable as error:
            self._send(503, json_bytes({"error": str(error)[:800]}))
        except RestoredApprovalError as error:
            self._send(409, json_bytes({"error": str(error)}))
        except FileNotFoundError:
            self._send(404, json_bytes({"error": "记录或资源不存在。"}))
        except ValidationError as error:
            detail = error.message if error.validator is None else f"{error.json_path} ({error.validator})"
            self._send(422, json_bytes({"error": f"科学数据校验未通过：{detail[:320]}"}))
        except (ValueError, OverflowError, BadZipFile) as error:
            self._send(400, json_bytes({"error": str(error)[:800] or "文件内容或参数无效。"}))
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except Exception as error:
            print(f"Workbench internal error ({type(error).__name__})", file=sys.stderr)
            self._send(500, json_bytes({"error": "本次操作未能完成，请检查文件和本地存储。"}))

    def _token(self):
        value = self.headers.get("Cookie", "")
        if len(value) > 4096:
            return None
        try:
            cookie = SimpleCookie(value).get(COOKIE_NAME)
        except CookieError:
            return None
        return cookie.value if cookie else None

    def _managed(self, path, post):
        access = self.server.access
        token = self._token()
        actor = access.actor(token) if token else None
        self.audit_event["actor"] = actor
        action = {"/api/session": "session.read", "/api/login": "session.login",
                  "/api/logout": "session.logout"}.get(path)
        scoped = PROJECT_PATH.fullmatch(path)
        if scoped:
            project, suffix = scoped.groups()
            action, ids = access_action("/api" + suffix, post)
            self.audit_event.update(project=project, **ids)
        self.audit_event["action"] = action or "project.unscoped"
        if post and self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
            self._send(403, json_bytes({"error": "请从同源工作台提交请求。"}))
            return None
        if path == "/api/session" and not post:
            self._session(actor)
            return None
        if path in {"/api/login", "/api/logout"} and post:
            self._session_action(path, actor, token)
            return None
        if not actor:
            self._send(401, json_bytes({"error": "请先登录项目工作台。"}))
            return None
        if not scoped or not (role := access.projects(actor).get(project)):
            self._send(403, json_bytes({"error": "此账号没有访问该项目的权限。"}))
            return None
        if (post and role == "viewer") or (suffix.startswith("/backups") and role != "admin"):
            self._send(403, json_bytes({"error": "当前项目角色不允许此操作。"}))
            return None
        return "/api" + suffix

    def _session(self, actor):
        self._send(200, json_bytes({"managed": True, "actor": actor,
                                    "projects": self.server.access.projects(actor) if actor else {}}))

    def _session_action(self, path, actor, token):
        body = self._json_body()
        flags = "; Path=/; HttpOnly; SameSite=Strict"
        access = self.server.access
        if path == "/api/logout":
            if body:
                raise ValueError("退出请求不接受额外参数。")
            if token:
                access.logout(token)
            self.session_cookie = COOKIE_NAME + "=; Max-Age=0" + flags
            self._session(None)
            return
        if (set(body) != {"username", "password"}
                or not all(isinstance(value, str) for value in body.values())):
            raise ValueError("请提供账号和密码。")
        from packages.agent.access import RateLimitError
        try:
            new_token = access.login(body["username"], body["password"])
        except RateLimitError:
            self._send(429, json_bytes({"error": "登录尝试过于频繁，请稍后再试。"}))
            return
        if new_token is None:
            self._send(401, json_bytes({"error": "账号或密码无效，或尝试过于频繁。"}))
            return
        if token:
            access.logout(token)
        actor = access.actor(new_token)
        self.audit_event["actor"] = actor
        self.session_cookie = COOKIE_NAME + "=" + new_token + flags
        self._session(actor)

    def _json_body(self):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("请求需要 JSON。")
        size = int(self.headers.get("Content-Length", "-1"))
        if self.headers.get("Transfer-Encoding") or not 0 < size <= 8192:
            raise ValueError("JSON 请求须在 8 KiB 内。")
        self.connection.settimeout(15)
        data = self.rfile.read(size)
        if len(data) != size:
            raise ValueError("JSON 请求未接收完整。")
        body = json.loads(data)
        if not isinstance(body, dict):
            raise ValueError("请求需要 JSON 对象。")
        return body

    def _run_view(self, view):
        if self.server.access is not None:
            prefix = "/api/projects/" + self.audit_event["project"]
            view["manifest_url"] = prefix + view["manifest_url"][4:]
            for artifact in view["artifacts"]:
                artifact["url"] = prefix + artifact["url"][4:]
        return view

    def _get(self, path):
        if path in self.server.assets:
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            if path in {"/", "/index.html"}:
                mime = "text/html; charset=utf-8"
            self._send(200, self.server.assets[path], mime)
            return
        guides = {"/guide/vasp": "vasp-import.md", "/guide/kinetics": "kinetics-import.md",
                  "/guide/cell": "cell.md", "/guide/md": "lammps-import.md",
                  "/guide/equipment": "equipment-import.md", "/guide/vtu-format": "vtu-format.md",
                  "/guide/md-job": "md-job.md"}
        if path in guides:
            self._send(200, (ROOT / "docs" / guides[path]).read_bytes(), "text/plain; charset=utf-8")
            return
        store = self.workspace
        if self.server.access is not None:
            project = self.audit_event["project"]
            if path == "/api/backups":
                self._send(200, json_bytes({"backups": self.server.backups.list(project)}))
                return
            if backup := BACKUP_PATH.fullmatch(path):
                stream, size = self.server.backups.open(project, backup[1])
                with stream:
                    if self._headers(200, size, "application/zip", backup[1] + ".zip"):
                        shutil.copyfileobj(stream, self.wfile, length=1024 * 1024)
                return
        if path == "/api/plans":
            approvals = self.approvals
            plans = approvals.list()
            listing = {"plans": plans, "synthetic_submission": self.synthetic_submission,
                       "md_submission": approvals.md_scheduler is not None}
            if approvals.recovery:
                listing["recovery"] = approvals.recovery
                listing["receipt_plan_ids"] = [
                    plan["id"] for plan in plans
                    if plan["job_id"] and plan["spec"]["workflow"] == "synthetic-v100"
                    and self.receipts.result_path(plan).is_file()
                ]
            self._send(200, json_bytes(listing))
            return
        if (md := MD_PLAN_PATH.fullmatch(path)) and (md[2] == "status" or md[3]):
            scheduler, record = self._md_plan(md[1])
            if md[3]:
                stream, size = scheduler.artifact(record, md[3])
                with stream:
                    if self._headers(200, size, "application/octet-stream", md[3]):
                        remaining = size
                        while remaining and (chunk := stream.read(min(1024 * 1024, remaining))):
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
            else:
                self._send_md_status(scheduler.status(record))
            return
        receipt = RECEIPT_PATH.fullmatch(path)
        if receipt:
            plan = self.approvals.get(receipt[1])
            if plan["spec"]["workflow"] != "synthetic-v100" or not plan["job_id"]:
                raise FileNotFoundError()
            filename, data = self.receipts.result_receipt(
                plan, archived=self.approvals.recovery is not None
            )
            self._send(200, data, filename=filename)
            return
        plan = PLAN_PATH.fullmatch(path)
        if plan and plan[2] is None:
            self._send(200, json_bytes(self.approvals.get(plan[1])))
            return
        if path == "/api/runs":
            self._send(200, json_bytes({"runs": store.recent()}))
            return
        handoff = MD_EXPORT_PATH.fullmatch(path)
        if handoff:
            name, raw = store.download(handoff[1], handoff[2])
            self._md_handoff(name, raw, {}, {"run_id": handoff[1], "artifact_id": handoff[2]})
            return
        match = RUN_PATH.fullmatch(path)
        if not match:
            raise FileNotFoundError()
        run, suffix, artifact = match.groups()
        if artifact:
            name, data = store.download(run, artifact)
            self._send(200, data, "application/octet-stream", name)
        elif suffix:
            self._send(200, json_bytes(store.manifest(run)), filename="manifest.json")
        else:
            self._send(200, json_bytes(self._run_view(store.detail(run))))

    def _plan_action(self, path):
        match = PLAN_PATH.fullmatch(path)
        if path != "/api/plans" and (not match or not match[2]):
            raise FileNotFoundError()
        if self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
            self._send(403, json_bytes({"error": "人工确认操作须从同源工作台发起。"}))
            return
        if self.headers.get_content_type() != "application/json":
            self._send(415, json_bytes({"error": "计划请求需要 JSON。"}))
            return
        size = int(self.headers.get("Content-Length", "-1"))
        if self.headers.get("Transfer-Encoding") or not 0 < size <= 8192:
            self._send(413, json_bytes({"error": "计划请求须在 8 KiB 内。"}))
            return
        self.connection.settimeout(15)
        data = self.rfile.read(size)
        if len(data) != size:
            raise ValueError("计划请求未接收完整。")
        body = json.loads(data)
        if not isinstance(body, dict):
            raise ValueError("计划请求需要 JSON 对象。")
        approvals = self.approvals
        if path == "/api/plans":
            if approvals.recovery:
                raise RestoredApprovalError("恢复副本中的审批记录仅供核对。")
            record = approvals.create(plan_spec(self.workspace, body, self.synthetic_submission))
        elif match[2] == "confirm":
            if set(body) != {"digest", "confirmed"} or body["confirmed"] is not True:
                raise ValueError("需要对当前计划摘要进行人工确认。")
            if not isinstance(body["digest"], str) or not re.fullmatch("[0-9a-f]{64}", body["digest"]):
                raise ValueError("计划摘要格式无效。")
            record = approvals.confirm(match[1], body["digest"])
        else:
            if body:
                raise ValueError("查询回执不接受提交参数。")
            record = approvals.reconcile(match[1])
        self._send(200, json_bytes(record))

    def _md_plan(self, plan_id):
        scheduler = self.approvals.md_scheduler
        record = self.approvals.get(plan_id)
        if scheduler is None or record["spec"]["mode"] != "slurm-md":
            raise FileNotFoundError()
        return scheduler, record

    def _send_md_status(self, result):
        if self.server.access is not None:
            prefix = "/api/projects/" + self.audit_event["project"]
            for artifact in result["artifacts"]:
                artifact["url"] = prefix + artifact["url"][4:]
        self._send(200, json_bytes(result))

    def _md_plan_action(self, match):
        if self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
            self._send(403, json_bytes({"error": "请从同源工作台提交请求。"}))
            return
        scheduler, plan = self._md_plan(match[1])
        body = self._json_body()
        if match[2] == "cancel":
            if body.keys() != {"confirmed"} or body["confirmed"] is not True:
                raise ValueError("Cancel requires explicit confirmation")
            self._send_md_status(scheduler.cancel(plan))
        else:
            self._send(200, json_bytes(scheduler.restart(self.approvals, plan, body)))

    def _md_handoff(self, name, raw, options, provenance=None):
        from packages.science.md_handoff import export_structure

        data, metadata = export_structure(name.rsplit("/", 1)[-1], raw, options)
        metadata.update(source_filename=name, converter_commit=self.server.commit,
                        project_id=self.workspace.project, **(provenance or {}))
        package = io.BytesIO()
        with ZipFile(package, "w", compression=ZIP_DEFLATED) as zip_file:
            zip_file.writestr("structure.data", data)
            zip_file.writestr("metadata.json", json_bytes(metadata) + b"\n")
            zip_file.writestr("in.read_geometry",
                              "units metal\natom_style atomic\nboundary p p p\nread_data structure.data\n")
        self._send(200, package.getvalue(), "application/zip", "vasp-to-lammps.zip")

    def _md_job_source(self, fields):
        structure = fields.get("file")
        run_id, artifact_id = fields.get("run_id"), fields.get("artifact_id")
        provenance = {"project_id": self.workspace.project, "operator_id": self.workspace.operator,
                      "code_commit": self.server.commit}
        if run_id or artifact_id:
            if (structure is not None or not isinstance(run_id, str) or not isinstance(artifact_id, str)
                    or not re.fullmatch(r"run-[0-9a-f]{64}", run_id)
                    or not re.fullmatch(r"art-[0-9a-f]{64}", artifact_id)):
                raise ValueError("请选择一个已有结构工件或上传一个结构。")
            target = {"run_id": run_id, "artifact_id": artifact_id}
            if self.audit_event is not None:
                self.audit_event.update(target)
            name, raw = self.workspace.download(run_id, artifact_id)
            provenance.update(source_filename=name, **target)
        elif structure is not None:
            name, raw = structure
        else:
            raise ValueError("请选择 VASP 结构文件。")
        potential = fields.get("potential")
        if potential is not None:
            provenance["potential_filename"] = potential[0]
        return name.rsplit("/", 1)[-1], raw, potential[1] if potential is not None else None, provenance

    def _prepare_md_job(self, fields):
        from packages.science.md_job import build_job

        name, raw, potential, provenance = self._md_job_source(fields)
        package = build_job(name, raw, fields["options"], potential=potential, provenance=provenance)
        self._send(200, package, "application/zip", "lammps-md-job.zip")

    def _post(self, path):
        if (md := MD_PLAN_PATH.fullmatch(path)) and md[2] in {"cancel", "restart"}:
            self._md_plan_action(md)
            return
        if path == "/api/plans" or path.startswith("/api/plans/"):
            self._plan_action(path)
            return
        if path not in {"/api/runs", "/api/cell", "/api/md-handoff", "/api/md-job", "/api/md-job/plan"}:
            raise FileNotFoundError()
        if path == "/api/md-job/plan":
            if self.approvals.md_scheduler is None:
                raise FileNotFoundError()
            if self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
                self._send(403, json_bytes({"error": "请从同源工作台提交请求。"}))
                return
        size = int(self.headers.get("Content-Length", "-1"))
        if self.headers.get("Transfer-Encoding") or not 0 < size <= self.server.upload_limit:
            self._send(413, json_bytes({"error": f"文件表单须小于 {self.server.upload_limit // (1024*1024)} MiB。"}))
            return
        if not self.server.analysis_slots.acquire(blocking=False):
            self._send(503, json_bytes({"error": "本机分析进程正忙，请稍后重试。"}))
            return
        try:
            self.connection.settimeout(90)
            data = self.rfile.read(size)
            if len(data) != size:
                raise ValueError("上传提前结束。")
            fields = form_fields(self.headers, data, md_job=path in {"/api/md-job", "/api/md-job/plan"})
            if path == "/api/md-job/plan":
                scheduler = self.approvals.md_scheduler
                plan = scheduler.create(self.approvals, fields["options"], lambda: self._md_job_source(fields))
                if self.audit_event is not None:
                    self.audit_event["plan_id"] = plan["id"]
                self._send(200, json_bytes(plan))
                return
            if path == "/api/md-job":
                self._prepare_md_job(fields)
                return
            transport_verification = None
            auto_transport = path == "/api/runs" and "file" not in fields
            if auto_transport:
                if fields.get("kind") != "md_transport":
                    raise ValueError("自动输运采集只适用于 MD 输运分析。")
                plan_id, job_id = fields.get("transport_plan_id"), fields.get("transport_job_id")
                if not plan_id or not job_id:
                    raise ValueError("自动输运采集需要 plan ID 和 job ID。")
                options, collected, transport_verification, plan_origin = resolve_plan_transport(
                    self.approvals, self.approvals.md_scheduler, plan_id, job_id,
                    fields["options"], self.server.upload_limit, fields.get("origin"))
                primary_role = options["transport_primary_role"]
                primary = collected.pop("transport_" + primary_role, None)
                if primary is None:
                    raise ValueError("授权计划没有可读取的主输运工件。")
                name, blob = primary
                fields["options"] = options
                fields["origin"] = plan_origin
                transport_files = collected
                transport_fields = {"transport_plan_id": plan_id, "transport_job_id": job_id}
            else:
                name, blob = fields["file"]
                transport_files = {key: fields[key] for key in sorted(fields)
                                   if key.startswith("transport_") and isinstance(fields[key], tuple)}
                transport_fields = {key: fields[key] for key in ("transport_plan_id", "transport_job_id")
                                    if key in fields}
                if transport_files and fields.get("kind") != "md_transport":
                    raise ValueError("输运原始文件只能用于 MD 输运导入。")
                if transport_files:
                    transport_verification = resolve_uploaded_transport(
                        self.approvals, name, blob, fields["options"], transport_files)
            if path == "/api/md-handoff":
                if "reference" in fields or any(key.startswith("transport_") for key in fields):
                    raise ValueError("结构交接只接收一个 VASP 结构文件。")
                self._md_handoff(name, blob, fields["options"])
                return
            if path == "/api/cell":
                from packages.science.cell import plan_from_poscar
                if any(key.startswith("transport_") for key in fields):
                    raise ValueError("晶胞预检不接收输运原始文件。")
                if "reference" in fields:
                    raise ValueError("晶胞预检只接收一个 POSCAR。")
                result = plan_from_poscar(blob, fields["options"])
            else:
                result = self._run_view(self.workspace.analyze(
                    fields.get("kind"), name, blob, fields["options"],
                    fields.get("origin"), fields.get("reference"),
                    transport_files=transport_files, transport_fields=transport_fields,
                    transport_verification=transport_verification,
                ))
            self._send(200, json_bytes(result))
        finally:
            self.server.analysis_slots.release()

    def do_GET(self):
        self._request(False)

    def do_POST(self):
        self._request(True)


def assert_project_layout(data_dir, project):
    projects = data_dir / "projects"
    root = projects / project
    for path in (projects, root, root / "raw", root / "runs", root / "approvals",
                 root / "approvals" / "approvals.sqlite3"):
        if path.is_symlink():
            raise ValueError("项目数据目录配置不安全。")


def mark_managed(data_dir, managed):
    marker = data_dir / ".managed-access"
    if not managed:
        if marker.exists() or marker.is_symlink():
            raise ValueError("This data root requires managed project access")
        return
    if data_dir.is_symlink() or any((path / ".git").exists() for path in (data_dir, *data_dir.parents)):
        raise ValueError("Managed data needs a real directory outside Git")
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = data_dir.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Managed data root must be private to the service OS account (0700)")
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        if marker.is_symlink() or not marker.is_file():
            raise ValueError("Invalid managed data marker")
    else:
        with os.fdopen(fd, "w") as stream:
            stream.write("managed-v1\n")
            stream.flush()
            os.fsync(stream.fileno())


def project_state(data_dir, project, operator, commit, submit, md_broker=None):
    store = Workspace(data_dir, project, operator, commit)
    receipts = SyntheticSlurm(store.runs.parent / "approvals" / "slurm")
    md_scheduler = MDSlurm(data_dir, project, md_broker) if md_broker is not None else None
    approvals = ApprovalStore(data_dir, project, operator, receipts if submit else None,
                              md_scheduler=md_scheduler)
    return store, approvals, receipts


class WorkbenchServer(ThreadingHTTPServer):
    md_broker = None

    def server_close(self):
        try:
            super().server_close()
        finally:
            if self.md_broker is not None:
                self.md_broker.close()
                self.md_broker = None


def make_server(data_dir, project, operator, port, max_upload_mib=64, workers=2,
                synthetic_submission=False, *, access_policy=None, audit_log=None, backup_root=None,
                md_slurm_config=None):
    if min(max_upload_mib, workers) <= 0:
        raise ValueError("Limits must be positive")
    data_dir = Path(data_dir).expanduser().absolute()
    managed = access_policy is not None
    if managed != (audit_log is not None) or managed != (backup_root is not None):
        raise ValueError("Managed mode requires --access-policy, --audit-log and --backup-root together")
    if managed and synthetic_submission:
        raise ValueError("Managed mode does not use the unmanaged synthetic GPU probe")
    access = audit = backups = None
    if managed:
        from packages.agent.access import AccessPolicy, AuditLog
        from packages.agent.project_backups import ProjectBackups

        managed_paths = [Path(path).expanduser().absolute()
                         for path in (access_policy, audit_log, backup_root)]
        projects_root = (data_dir / "projects").resolve()
        if any(path.resolve().is_relative_to(projects_root) for path in managed_paths):
            raise ValueError("Keep policy, audit and archive data outside the project tree")
        if len({path.resolve() for path in managed_paths}) != len(managed_paths):
            raise ValueError("Use separate locations for policy, audit and archive data")
        access, audit, backups = AccessPolicy(managed_paths[0]), AuditLog(managed_paths[1]), ProjectBackups(managed_paths[2])
    mark_managed(data_dir, managed)
    assets = static_files()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    server = WorkbenchServer(("127.0.0.1", port), Handler)
    try:
        if md_slurm_config is not None:
            server.md_broker = SlurmBroker(data_dir, md_slurm_config)
        store, approvals, receipts = (None, None, None) if managed else project_state(
            data_dir, project, operator, commit, synthetic_submission, server.md_broker
        )
    except BaseException:
        server.server_close()
        raise
    server.access, server.audit, server.backups = access, audit, backups
    server.data_dir, server.commit = data_dir, commit
    server.slurm_receipts, server.approvals = receipts, approvals
    server.synthetic_submission = approvals is not None and approvals.scheduler is not None
    server.workspace, server.assets = store, assets
    server.upload_limit = max_upload_mib * 1024 * 1024
    server.analysis_slots = threading.BoundedSemaphore(workers)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_dir = "D:/research-data/catalysis-agent" if os.name == "nt" else "~/.local/share/catalysis-agent"
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("CATALYSIS_DATA_ROOT", default_dir)))
    parser.add_argument("--project", default="local")
    parser.add_argument("--operator", default="local-user")
    parser.add_argument("--port", type=int, default=8771)
    parser.add_argument("--max-upload-mib", type=int, default=64)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--a6-synthetic-slurm", action="store_true",
                        help="Enable human-confirmed short synthetic jobs on the V100 GPU partition")
    parser.add_argument("--md-slurm-config", type=Path,
                        help="Enable confirmed LAMMPS Slurm jobs using an operator-maintained JSON profile")
    parser.add_argument("--access-policy", type=Path)
    parser.add_argument("--audit-log", type=Path)
    parser.add_argument("--backup-root", type=Path)
    args = parser.parse_args()
    with make_server(args.data_dir.expanduser(), args.project, args.operator, args.port,
                     args.max_upload_mib, args.workers, args.a6_synthetic_slurm,
                     access_policy=args.access_policy, audit_log=args.audit_log, backup_root=args.backup_root,
                     md_slurm_config=args.md_slurm_config) as server:
        if server.access is not None:
            restrict_egress()
            server.audit.record(dict(time=datetime.now(timezone.utc).isoformat(),
                                     request_id=uuid4().hex, actor=None, project=None,
                                     action="service.start", outcome="allowed", status=200))
        print(f"http://127.0.0.1:{server.server_port}/#studio", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
