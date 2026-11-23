import json
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from packages.agent.model_broker import ModelBroker


class IndependentStudio(unittest.TestCase):
    def test_release_archive_preserves_real_commit_without_git(self):
        from packages.revision import source_commit
        with tempfile.TemporaryDirectory() as directory, patch('subprocess.check_output') as git:
            root = Path(directory)
            (root / 'baselines').mkdir()
            stamp = root / 'baselines/source-commit.txt'
            stamp.write_text('$Format:%H$\n')
            with self.assertRaises(ValueError):
                source_commit(root)
            stamp.write_text('a' * 40 + '\n')
            self.assertEqual(source_commit(root), 'a' * 40)
            git.assert_not_called()

    def test_no_legacy_tag_still_serves_electrocatalysis_and_analysis(self):
        from apps.server import static_files
        with patch('apps.server.baseline_git', return_value=b''):
            assets = static_files()
        self.assertIn(b'science.js', assets['/'])
        self.assertIn(b'/analysis.js', assets['/'])
        self.assertNotIn('/general/', assets)
        self.assertNotIn(b'content="general"', assets['/'])

    @unittest.skipUnless(shutil.which('node'), 'optional model bridge needs Node.js')
    def test_model_tool_call_with_only_repo_client_and_local_provider(self):
        waiting, release = threading.Event(), threading.Event()
        class Provider(BaseHTTPRequestHandler):
            def do_POST(self):
                self.server.request_body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                message = {'tool_calls': [{'id': 'fit-1', 'function': {'name': 'fit_kinetics',
                           'arguments': '{"model":"arrhenius_known_k"}'}}]}
                if self.server.request_body['messages'][-1]['content'] == '需要停止':
                    waiting.set()
                    release.wait(6)
                    self.close_connection = True
                    return
                if '候选位点' in self.server.request_body['messages'][-1]['content']:
                    message = {'tool_calls': [{'id': 'calc', 'function': {'name': 'calculate_che', 'arguments':
                        '{"reaction":"her","potential":"0 V vs RHE","energies":["0.22 eV"]}'}}]}
                elif self.server.request_body['messages'][-1]['content'] == '接着解释原因':
                    message = {'content': '这是带上文的模型回复。'}
                elif self.server.request_body['tools'][0]['function']['name'] == 'select_electrochem_tool':
                    message = {'tool_calls': [{'id': 'plan-1', 'function': {'name': 'select_electrochem_tool',
                               'arguments': '{"tool":"oer"}'}}]}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'choices': [{'message': message}]}).encode())

            def log_message(self, *args):
                pass

        with HTTPServer(('127.0.0.1', 0), Provider) as server, tempfile.TemporaryDirectory() as directory:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(thread.join, 2)
            self.addCleanup(server.shutdown)
            config = Path(directory, 'model.env')
            config.write_text(f'CATALYSIS_MODEL_BASE_URL=http://127.0.0.1:{server.server_port}/v1\n'
                              'CATALYSIS_MODEL=fixture\nCATALYSIS_MODEL_API_KEY=test\n')
            broker = ModelBroker(config)
            try:
                reply = broker.call({'instruction': '拟合速率常数', 'filename': 'sample.csv'})
                from apps.server import make_server
                with make_server(directory, 'local', 'test', 0) as studio:
                    worker = threading.Thread(target=studio.serve_forever, daemon=True)
                    worker.start()
                    endpoint = f'http://127.0.0.1:{studio.server_port}/api/agent/electrochem'
                    def ask(payload, url=endpoint):
                        request = Request(url, data=json.dumps(payload).encode(),
                                          headers={'Content-Type': 'application/json'})
                        with build_opener(ProxyHandler({})).open(request, timeout=5) as response:
                            return json.load(response)
                    try:
                        with self.assertRaises(HTTPError) as disabled:
                            ask({'instruction': '析氧自由能图'})
                        self.assertEqual(disabled.exception.code, 503)
                        studio.model_broker = broker
                        with self.assertRaises(HTTPError) as invalid:
                            ask({'instruction': '析氧自由能图', 'file': 'raw data'})
                        self.assertEqual(invalid.exception.code, 400)
                        self.assertEqual(ask({'instruction': '析氧自由能图'})['tool'], 'oer')
                        self.assertEqual(server.request_body['messages'][-1]['content'], '析氧自由能图')
                        send = endpoint.replace('agent/electrochem', 'chats/' + 'a' * 32 + '/send')
                        first = ask({'id': 'c'*32, 'expected': 0, 'question': '运行 OER 示例'}, send)
                        self.assertTrue(first['turns'][0]['reply']['plot']['example'])
                        second = ask({'id': 'd'*32, 'expected': 1, 'question': '接着解释原因'}, send)
                        self.assertEqual(second['turns'][1]['reply']['text'], '这是带上文的模型回复。')
                        self.assertEqual(server.request_body['messages'][1]['content'], '运行 OER 示例')
                        interrupted = []
                        def slow_turn():
                            try:
                                ask({'id': 'e'*32, 'expected': 2, 'question': '需要停止'}, send)
                            except HTTPError as error:
                                interrupted.append(error.code)
                        thread = threading.Thread(target=slow_turn)
                        thread.start()
                        try:
                            self.assertTrue(waiting.wait(3))
                            prior = ask({'id': 'e'*32}, send.removesuffix('send')+'stop')
                            self.assertEqual(len(prior['turns']), 2)
                            thread.join(3)
                            self.assertEqual(interrupted, [503])
                        finally:
                            release.set()
                            thread.join(3)
                        calc = ask({'id': 'f'*32, 'expected': 2,
                                    'question': '计算候选位点：HER，H* 为 0.22 eV，在 0 V vs RHE。'}, send)
                        self.assertEqual(calc['turns'][-1]['reply']['plot']['energies'], [0.22])
                        other = send.replace('a'*32, '9'*32)
                        missing = ask({'id':'2'*32, 'expected':0, 'question':'计算候选位点。'}, other)
                        self.assertNotIn('plot', missing['turns'][0]['reply'])
                    finally:
                        studio.model_broker = None
                        studio.shutdown()
                        worker.join()
            finally:
                broker.close()
            self.assertEqual(reply['call_id'], 'fit-1')
            self.assertEqual(reply['model'], 'fixture')
            self.assertEqual(server.request_body['tools'][0]['function']['name'], 'select_electrochem_tool')
