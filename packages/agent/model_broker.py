"""A single MLCC-compatible model bridge; scientific files remain in the workbench."""
import json
from pathlib import Path
import subprocess
from threading import Lock

class ModelUnavailable(RuntimeError):
    pass

class ModelBroker:
    def __init__(self, config):
        root = Path(__file__).resolve().parent
        self.process = subprocess.Popen(
            ['bash', '-c', 'set -a; . "$1"; set +a; exec /home/v100/mlcc-independent/bin/node "$2"',
             'model-broker', str(config), str(root / 'model_broker.mjs')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.lock = Lock()

    def call(self, request):
        with self.lock:
            try:
                self.process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
                self.process.stdin.flush()
                line = self.process.stdout.readline()
                result = json.loads(line)
            except (BrokenPipeError, OSError, ValueError) as exc:
                raise ModelUnavailable('模型通道不可用，请检查 MLCC 服务配置。') from exc
            if not result.get('ok'):
                raise ModelUnavailable(result.get('error', '模型调用失败'))
            return result

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
