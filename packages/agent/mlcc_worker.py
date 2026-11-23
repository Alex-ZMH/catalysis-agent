"""Run the catalysis bridge over stdio beside MLCC's private provider config."""
import json
import os
from pathlib import Path
import re
import shlex


def worker_command(config):
    profile = json.loads(Path(config).read_text(encoding='utf-8'))
    if (not isinstance(profile, dict) or set(profile) != {'host', 'user', 'port'}
            or not isinstance(profile['host'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', profile['host'])
            or not isinstance(profile['user'], str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]{0,63}', profile['user'])
            or type(profile['port']) is not int or not 1 <= profile['port'] <= 65535):
        raise ValueError('MLCC SSH 配置仅接受 host、user、port；不要填写密码或密钥。')
    ssh = ['ssh', '-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
           '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=30',
           '-o', 'ServerAliveCountMax=3', '-o', 'NumberOfPasswordPrompts=1']
    if control := os.environ.get('CATALYSIS_SSH_CONTROL'):
        ssh.extend(['-S', control, '-o', 'BatchMode=yes'])
    root = Path(__file__).resolve().parents[2]
    setup = ['set -eu', 'umask 077', 'base="$HOME/mlcc-independent"',
             'bundle=$(mktemp -d "${TMPDIR:-/tmp}/catalysis-bridge.XXXXXXXX")',
             '''trap 'rm -rf -- "$bundle"' EXIT''', '''trap 'exit 1' HUP INT TERM''',
             'mkdir -p "$bundle/apps/web/electrochem" "$bundle/packages/agent"',
             'ln -s "$base/bin/model-client.mjs" "$bundle/packages/agent/model-client.mjs"']
    for asset in ('packages/agent/model_broker.mjs', 'apps/web/electrochem/chat.js', 'apps/web/electrochem/science.js'):
        setup.append(f'''printf %s {shlex.quote((root / asset).read_text(encoding='utf-8'))} > "$bundle/{asset}"''')
    loader = """
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
const profile = parseEnv(readFileSync(process.argv[1], 'utf8'));
for (const key of ['MLCC_MODEL','MLCC_MODEL_API_FORMAT','MLCC_MODEL_BASE_URL','MLCC_MODEL_API_KEY']) {
  if (profile[key]) process.env[key] = profile[key];
}
await import(pathToFileURL(process.argv[2]));
"""
    setup.append('env -i HOME="$HOME" PATH=/usr/bin:/bin "$base/bin/node" --input-type=module -e '
                 + shlex.quote(loader) + ' "$base/config/worker.env" "$bundle/packages/agent/model_broker.mjs"')
    return [*ssh, '-p', str(profile['port']), '-l', profile['user'], profile['host'], '\n'.join(setup)]
