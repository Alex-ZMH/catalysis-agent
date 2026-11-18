"""Local workbench HTTP entry point. The service has no outbound or scheduler client."""
import argparse
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
from urllib.parse import quote, urlsplit
from zipfile import BadZipFile, ZipFile

from jsonschema import ValidationError
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


class Handler(BaseHTTPRequestHandler):
    server_version = "CatalysisWorkbench"
    def log_message(self, fmt, *args):
        pass  # User file names, study parameters and requests are not written to access logs.

    def _send(self, status, data, mime="application/json; charset=utf-8", filename=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
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
        self.wfile.write(data)

    def _request(self, post):
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
        path = urlsplit(self.path).path
        try:
            if post:
                self._post(path)
            else:
                self._get(path)
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
        store = self.server.workspace
        if path == "/api/runs":
            self._send(200, json_bytes({"runs": store.recent()}))
            return
        match = re.fullmatch(r"/api/runs/(run-[0-9a-f]{64})(?:/(manifest|artifacts/(art-[0-9a-f]{64})))?", path)
        if not match:
            raise FileNotFoundError()
        run, suffix, artifact = match.groups()
        if artifact:
            name, data = store.download(run, artifact)
            self._send(200, data, "application/octet-stream", name)
        elif suffix:
            self._send(200, json_bytes(store.manifest(run)), filename="manifest.json")
        else:
            self._send(200, json_bytes(store.detail(run)))

    def _post(self, path):
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
                result = self.server.workspace.analyze(fields.get("kind"), name, blob, fields["options"],
                                                       fields.get("origin"), fields.get("reference"))
            self._send(200, json_bytes(result))
        finally:
            self.server.analysis_slots.release()

    def do_GET(self):
        self._request(False)

    def do_POST(self):
        self._request(True)


def make_server(data_dir, project, operator, port, max_upload_mib=64, workers=2):
    if min(max_upload_mib, workers) <= 0:
        raise ValueError("Limits must be positive")
    assets = static_files()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    store = Workspace(data_dir, project, operator, commit)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
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
    args = parser.parse_args()
    with make_server(args.data_dir.expanduser(), args.project, args.operator, args.port,
                     args.max_upload_mib, args.workers) as server:
        print(f"http://127.0.0.1:{server.server_port}/#studio", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
