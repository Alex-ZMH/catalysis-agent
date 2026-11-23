"""A single MLCC-compatible model bridge; scientific files remain in the workbench."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from threading import Lock
from packages.agent.mlcc_worker import worker_command

class ModelUnavailable(RuntimeError):
    pass

class ModelBroker:
    def __init__(self, config, *, shell_config=False, ssh_worker=False):
        root = Path(__file__).resolve().parent
        node = shutil.which(os.environ.get('CATALYSIS_NODE', 'node'))
        if not ssh_worker and node is None:
            raise ModelUnavailable('启用模型需要 Node.js 22.18+；请配置 PATH 或 CATALYSIS_NODE。')
        config = Path(config).expanduser().resolve(strict=True)
        self.allow_planner = not shell_config
        bridge = str(root / 'model_broker.mjs')
        command = worker_command(config) if ssh_worker else (['bash', '-c', 'set -a; . "$1" || exit; set +a; exec "$2" "$3"',
                    'model-broker', str(config), node, bridge] if shell_config else
                   [node, f'--env-file={config}', bridge])
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)
        self.lock = Lock()
        self.write_lock = Lock()
        if ssh_worker:
            try:
                self.call({'mode': 'info'})
            except BaseException:
                self.close()
                raise

    def _write(self, request, stopped=None):
        with self.write_lock:
            if stopped is not None and stopped.is_set():
                raise ModelUnavailable('本次回答已停止。')
            self.process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
            self.process.stdin.flush()

    def cancel(self, token):
        self._write({'mode': 'cancel', 'token': token})

    def call(self, request, *, stopped=None):
        with self.lock:
            try:
                self._write(request, stopped)
                line = self.process.stdout.readline()
                result = json.loads(line)
            except (BrokenPipeError, OSError, ValueError) as exc:
                raise ModelUnavailable('模型通道不可用，请检查模型配置与 Node.js 版本。') from exc
            if not result.get('ok'):
                raise ModelUnavailable(result.get('error', '模型调用失败'))
            return result

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        finally:
            self.process.stdin.close()
            self.process.stdout.close()
