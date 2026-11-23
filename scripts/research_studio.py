"""Start the local research site and its isolated V100 worker."""
import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'apps/research'
ORIGIN = 'http://127.0.0.1:8773'
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(ORIGIN + '/api/' + path, data=body,
                                 headers={'Content-Type': 'application/json', 'Origin': ORIGIN})
    with HTTP.open(req, timeout=4) as res:
        return json.load(res)


def open_studio(state, account):
    login = {key: account[key] for key in ('contact', 'password')}
    try:
        user = request('login', login)['user']
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
        user = request('register', {**login, 'name': '本机研究员', 'inviteCode': account['invite']})['user']
    directory = state / 'desktop-grants'
    directory.mkdir(mode=0o700, exist_ok=True)
    for old in directory.iterdir():
        if old.stat().st_mtime < time.time()-300:
            old.unlink(missing_ok=True)
    token = secrets.token_hex(32)
    path = directory / hashlib.sha256(token.encode()).hexdigest()
    path.write_text(json.dumps({'expires': int(time.time()*1000)+120000, 'user': user}))
    webbrowser.open(ORIGIN + '/#desktop=' + token)


def worker_bundle():
    buffer = io.BytesIO()
    sources = [ROOT / 'apps/web/electrochem/science.js']
    sources.extend(p for p in (APP/'standalone').glob('*.mjs')
                   if not p.name.endswith('.test.mjs') and p.name not in ('store.mjs','artifact-transport.mjs'))
    sources.extend(APP/'standalone'/name for name in ('basal-quick.py', 'basal-dos.py'))
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for path in sources:
            tar.add(path, arcname=str(path.relative_to(ROOT)), recursive=False)
    return buffer.getvalue()


def ssh_options(profile):
    if (not isinstance(profile, dict) or set(profile) != {'host','port','user'}
        or not re.fullmatch(r'[a-zA-Z0-9][\w.-]*', str(profile['host']))
        or not re.fullmatch(r'[\w][\w-]*', str(profile['user']))
        or type(profile['port']) is not int or not 1 <= profile['port'] <= 65535):
        raise ValueError('SSH 配置须包含 host、user 和 port。')
    return ['-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','-o','ServerAliveInterval=20',
            '-o','ServerAliveCountMax=3','-o','ConnectTimeout=12','-p',str(profile['port']),'-l',profile['user']]


def run(args):
    os.umask(0o077)
    state = Path(os.environ.get('CATALYSIS_RESEARCH_DATA', '~/.local/share/catalysis-agent/research-studio')).expanduser()
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    config = state/'desktop.json'
    owner = (state/'service.lock').open('a')
    try:
        fcntl.flock(owner, fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        if not args.no_open:
            open_studio(state, json.loads(config.read_text()))
        return
    if not config.exists():
        payload = {'contact':'desktop-'+secrets.token_hex(5)+'@local.invalid','password':secrets.token_urlsafe(32),'invite':secrets.token_urlsafe(32)}
        tmp = state/'desktop.tmp'
        tmp.write_text(json.dumps(payload))
        tmp.replace(config)
    account = json.loads(config.read_text())
    profile = json.loads(args.profile.expanduser().read_text())
    node = shutil.which('node')
    if not node:
        raise RuntimeError('需要 Node.js 22.18 或更新版本。')
    if not (APP/'dist/index.html').exists():
        subprocess.run(['npm','ci','--no-audit','--no-fund'],cwd=APP,check=True)
        subprocess.run(['npm','run','build'],cwd=APP,check=True)
    opts=ssh_options(profile)
    token=secrets.token_hex(32)
    env = {**os.environ,'CATALYSIS_DESKTOP':'1','MLCC_INVITE_CODE':account['invite'],'MLCC_WORKER_TOKEN':token}
    with tempfile.TemporaryDirectory(prefix='catalysis-ssh-',dir='/tmp') as temp, contextlib.ExitStack() as cleanup:
        sock=os.environ.get('CATALYSIS_SSH_CONTROL') or str(Path(temp)/'control')
        common=['ssh','-S',sock,*opts]
        host=profile['host']
        if not os.environ.get('CATALYSIS_SSH_CONTROL'):
            subprocess.run([*common,'-fMN','-o','ControlMaster=yes',host],check=True)
            cleanup.callback(subprocess.run,[*common,'-O','exit',host],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        remote=[*common,'-o','BatchMode=yes',host]
        release=subprocess.check_output([*remote,'umask 077; mktemp -d /tmp/catalysis-worker.XXXXXXXX'],text=True).strip()
        if not re.fullmatch(r'/tmp/catalysis-worker\.[a-zA-Z0-9]{8}',release):
            raise RuntimeError('Worker temporary directory invalid')
        cleanup.callback(subprocess.run,[*remote,'rm -rf -- '+release],timeout=20)
        subprocess.run([*remote,'umask 077; tar -xzf - -C '+release],input=worker_bundle(),check=True)
        server=subprocess.Popen([node,'server.mjs','--host','127.0.0.1','--port','8773','--data-dir',str(state)],cwd=APP,env=env)
        cleanup.callback(stop,server)
        for _ in range(60):
            if server.poll() is not None:
                raise RuntimeError('本机 8773 服务启动失败。')
            try:
                request('status')
                break
            except OSError:
                time.sleep(.2)
        worker=subprocess.Popen([*common,'-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes',
            '-R','127.0.0.1:25872:127.0.0.1:8773',host,
            'umask 077; exec "$HOME/mlcc-independent/bin/node" '+release+'/apps/research/standalone/launch-worker.mjs'],stdin=subprocess.PIPE)
        cleanup.callback(stop,worker)
        cleanup.callback(worker.stdin.close)
        worker.stdin.write((token+'\n').encode())
        worker.stdin.flush()
        try:
            for _ in range(120):
                if worker.poll() is not None:
                    raise RuntimeError('V100 worker 启动失败。')
                if request('status').get('status') in ('online','busy'):
                    print('电催化研究助手已在线。 '+ORIGIN+'/#studio',flush=True)
                    if not args.no_open:
                        open_studio(state,account)
                    break
                time.sleep(.5)
            else:
                raise RuntimeError('V100 worker 尚未就绪。')
            while server.poll() is None and worker.poll() is None:
                time.sleep(1)
            raise RuntimeError('服务连接已断开。重新双击启动器可恢复对话和查询已有作业。')
        finally:
            # A forwarded listener installed on a shared master can outlive its session.
            subprocess.run([*common,'-O','cancel','-R','127.0.0.1:25872:127.0.0.1:8773',host],
                           stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--no-open',action='store_true')
    parser.add_argument('--profile',type=Path,default=os.environ.get('CATALYSIS_MLCC_WORKER_CONFIG','~/.config/catalysis-agent/mlcc-worker.json'))
    signal.signal(signal.SIGTERM,lambda *_: sys.exit(0))
    try:
        run(parser.parse_args())
    except KeyboardInterrupt:
        pass
