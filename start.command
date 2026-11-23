#!/bin/zsh
set -eu
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
worker="${CATALYSIS_MLCC_WORKER_CONFIG:-$HOME/.config/catalysis-agent/mlcc-worker.json}"
if [[ -f "$worker" && -z "${CATALYSIS_MODEL_CONFIG:-}" && "${CATALYSIS_ANALYSIS_ONLY:-0}" != 1 ]]; then
  exec python3 scripts/research_studio.py --profile "$worker"
fi
if [[ -z "${CATALYSIS_MODEL_CONFIG:-}" ]] && curl -fsS --noproxy '*' --max-time 1 http://127.0.0.1:8771/ 2>/dev/null | grep -q 'name="catalysis-service"'; then
  if [[ -f "$worker" ]] && ! curl -fsS --noproxy '*' --max-time 2 http://127.0.0.1:8771/api/session | grep -Eq '"electrochem_planner"[[:space:]]*:[[:space:]]*true'; then
    print -u2 '端口 8771 上的旧服务尚未启用模型。请先停止旧服务，再重新启动。'
    exit 1
  fi
  open 'http://127.0.0.1:8771/#studio'
  exit 0
fi
python="${CATALYSIS_PYTHON:-.venv/bin/python}"
if [[ ! -x "$python" ]]; then python="$(command -v python3.13 || true)"; fi
if [[ -z "$python" ]]; then
  print -u2 '请先按 README 安装 Python 3.13 及锁定依赖，或用 CATALYSIS_PYTHON 指定已准备的解释器。'
  exit 1
fi
args=(--open)
if [[ -n "${CATALYSIS_MODEL_CONFIG:-}" ]]; then args+=(--model-config "$CATALYSIS_MODEL_CONFIG")
elif [[ -f "$worker" ]]; then args+=(--mlcc-worker-config "$worker"); fi
exec "$python" -m apps.server "${args[@]}"
