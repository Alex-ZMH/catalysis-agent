import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from packages.agent.mlcc_worker import worker_command


class WorkerConfigTests(unittest.TestCase):
    def test_reject_password_or_option_as_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory, 'worker.json')
            for profile in ({'host': '-invalid', 'user': 'test', 'port': 22},
                            {'host': 'host', 'user': 'test', 'port': 22, 'password': 'not-accepted'}):
                config.write_text(json.dumps(profile))
                with self.assertRaises(ValueError):
                    worker_command(config)

    @unittest.skipUnless(shutil.which('node'), 'requires Node.js')
    def test_worker_bootstrap_uses_model_settings_only_and_leaves_no_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / 'profile.json'
            config.write_text('{"host":"worker.test","port":22022,"user":"research"}')
            base = home / 'mlcc-independent'
            (base / 'bin').mkdir(parents=True)
            (base / 'bin/node').symlink_to(shutil.which('node'))
            (base / 'config').mkdir()
            (base / 'config/worker.env').write_text(
                'MLCC_MODEL=test-active\nMLCC_MODEL_API_FORMAT=responses\n'
                'MLCC_MODEL_BASE_URL=https://provider.invalid/v1\nMLCC_MODEL_API_KEY=test\n'
                'MLCC_WORKER_TOKEN=not-for-model-bridge\n')
            (base / 'bin/model-client.mjs').write_text(
                'if(process.env.MLCC_WORKER_TOKEN)throw Error("unexpected worker token");'
                'export function completeChat(){throw Error("metadata must not contact provider")}')
            temp = home / 'tmp'
            temp.mkdir()
            args = worker_command(config)
            self.assertIn('StrictHostKeyChecking=yes', args)
            self.assertNotIn('not-for-model-bridge', ' '.join(args))
            result = subprocess.run(['sh', '-c', args[-1]], env={**os.environ, 'HOME': directory,
                                    'TMPDIR': str(temp)}, capture_output=True, text=True, timeout=10,
                                    input='{"mode":"info"}\n', check=True)
            self.assertEqual(json.loads(result.stdout), {'ok': True, 'model': 'test-active', 'format': 'responses'})
            self.assertEqual(list(temp.iterdir()), [])
