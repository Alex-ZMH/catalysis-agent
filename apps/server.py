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
from zipfile import BadZipFile, ZipFile

from jsonschema import ValidationError
from packages.agent.approvals import ApprovalStore, RestoredApprovalError
from packages.agent.egress import restrict_egress
from packages.agent.slurm import SyntheticSlurm
from packages.agent.workspace import Workspace, json_bytes
from scripts.frontend_baseline import git as baseline_git, verify as verify_baseline

ROOT = Path(__file__).resolve().parents[1]


def static_files():
    verify_baseline(None)
    archive = baseline_git("archive", "--format=zip", "refs/tags/frontend-baseline-v1")
    with ZipFile(io.BytesIO(archive)) as zipped:
        files = {"/" + p: zipped.read(p) for p in zipped.namelist() if not p.endswith("/")
                 and not p.startswith("tools/")}
    for name in ("analysis.css", "analysis.js"):
        files["/" + name] = (ROOT / "apps" / "web" / name).read_bytes()
    overlay = b'<link rel="stylesheet" href="/analysis.css"><script defer src="/analysis.js"></script>'
    files["/"] = files["/index.html"] = files["/index.html"].replace(b"</head>", overlay + b"</head>")
    return files


def form_fields(headers, data):
    content_type = headers.get("Content-Type", "")
    if headers.get_content_type() != "multipart/form-data":
        raise ValueError("请以文件表单上传。")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + data)
    if not message.is_multipart() or message.defects:
        raise ValueError("上传表单不完整。")
    result = {}
    for part in message.iter_parts():
        key = part.get_param("name", header="Content-Disposition")
        if (part.is_multipart() or part.defects or part.get_content_disposition() != "form-data"
                or key in result or key not in {"file", "reference", "options", "kind", "origin"}
                or part.get("Content-Transfer-Encoding") is not None):
            raise ValueError("上传字段无效或重复。")
        value = part.get_payload(decode=True)
        if key in {"file", "reference"}:
            result[key] = (part.get_filename() or "", value)
        else:
            if len(value) > 256 * 1024:
                raise ValueError("配置超过 256 KiB。")
            result[key] = value.decode("utf-8")
    if "file" not in result:
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
PLAN_KINDS = {"vasp-relaxation": "adsorption", "md-simulation": "md",
              "equipment-simulation": "equipment"}


RUN_PATH = re.compile(r"/api/runs/(run-[0-9a-f]{64})(?:/(manifest|artifacts/(art-[0-9a-f]{64})))?")
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
    (True, "/api/plans"): "project.plan.create",
}


def access_action(path, post):
    if (post, path) in ACTIONS:
        return ACTIONS[post, path], {}
    if not post and (run := RUN_PATH.fullmatch(path)):
        run_id, suffix, artifact_id = run.groups()
        ids = {"run_id": run_id}
        if artifact_id:
            return "project.artifact.read", {**ids, "artifact_id": artifact_id}
        return "project.manifest.read" if suffix else "project.run.read", ids
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
                    self.audit_event["actor"], self.server.commit, False
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
                  "/guide/equipment": "equipment-import.md", "/guide/vtu-format": "vtu-format.md"}
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
            listing = {"plans": plans, "synthetic_submission": self.synthetic_submission}
            if approvals.recovery:
                listing["recovery"] = approvals.recovery
                listing["receipt_plan_ids"] = [
                    plan["id"] for plan in plans
                    if plan["job_id"] and plan["spec"]["workflow"] == "synthetic-v100"
                    and self.receipts.result_path(plan).is_file()
                ]
            self._send(200, json_bytes(listing))
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

    def _post(self, path):
        if path == "/api/plans" or path.startswith("/api/plans/"):
            self._plan_action(path)
            return
        if path not in {"/api/runs", "/api/cell"}:
            raise FileNotFoundError()
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
            fields = form_fields(self.headers, data)
            name, blob = fields["file"]
            if path == "/api/cell":
                from packages.science.cell import plan_from_poscar
                if "reference" in fields:
                    raise ValueError("晶胞预检只接收一个 POSCAR。")
                result = plan_from_poscar(blob, fields["options"])
            else:
                result = self._run_view(self.workspace.analyze(
                    fields.get("kind"), name, blob, fields["options"],
                    fields.get("origin"), fields.get("reference")
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


def project_state(data_dir, project, operator, commit, submit):
    store = Workspace(data_dir, project, operator, commit)
    receipts = SyntheticSlurm(store.runs.parent / "approvals" / "slurm")
    return store, ApprovalStore(data_dir, project, operator, receipts if submit else None), receipts


def make_server(data_dir, project, operator, port, max_upload_mib=64, workers=2,
                synthetic_submission=False, *, access_policy=None, audit_log=None, backup_root=None):
    if min(max_upload_mib, workers) <= 0:
        raise ValueError("Limits must be positive")
    data_dir = Path(data_dir).expanduser().absolute()
    managed = access_policy is not None
    if managed != (audit_log is not None) or managed != (backup_root is not None):
        raise ValueError("Managed mode requires --access-policy, --audit-log and --backup-root together")
    if managed and synthetic_submission:
        raise ValueError("Managed mode supports manual confirmation of plans only")
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
    store, approvals, receipts = (None, None, None) if managed else project_state(
        data_dir, project, operator, commit, synthetic_submission
    )
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
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
    parser.add_argument("--access-policy", type=Path)
    parser.add_argument("--audit-log", type=Path)
    parser.add_argument("--backup-root", type=Path)
    args = parser.parse_args()
    with make_server(args.data_dir.expanduser(), args.project, args.operator, args.port,
                     args.max_upload_mib, args.workers, args.a6_synthetic_slurm,
                     access_policy=args.access_policy, audit_log=args.audit_log, backup_root=args.backup_root) as server:
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
