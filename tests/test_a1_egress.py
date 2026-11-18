"""Exercise the Linux network boundary in a child, without sending off-host traffic."""
from pathlib import Path
import subprocess
import sys
import unittest


@unittest.skipUnless(sys.platform == "linux", "The managed service runs on Linux")
class EgressBoundary(unittest.TestCase):
    def test_guard_keeps_listener_and_denies_outbound_connections(self):
        code = """
import errno
from http.server import BaseHTTPRequestHandler, HTTPServer
from queue import Queue
import socket
import subprocess
import sys
from threading import Thread
from packages.agent.egress import restrict_egress

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"guarded")

def denied(op):
    try:
        op()
    except OSError as error:
        assert error.errno == errno.EPERM, error
    else:
        raise AssertionError("Network syscall unexpectedly succeeded")

with HTTPServer(("127.0.0.1", 0), Handler) as listener:
    with socket.socket() as preopened:
        restrict_egress()
        denied(lambda: preopened.connect(listener.server_address))
        for family, type_ in ((socket.AF_INET, socket.SOCK_STREAM),
                              (socket.AF_INET, socket.SOCK_DGRAM),
                              (socket.AF_INET6, socket.SOCK_STREAM),
                              (socket.AF_UNIX, socket.SOCK_STREAM)):
            denied(lambda: socket.socket(family, type_))
    results = Queue()
    def in_thread():
        denied(socket.socket)
        results.put(True)
    worker = Thread(target=in_thread)
    worker.start()
    worker.join()
    assert results.get(timeout=1)
    subprocess.run([sys.executable, "-c",
                    "import socket, errno;\\ntry: socket.socket()\\nexcept OSError as e: assert e.errno == errno.EPERM\\nelse: raise AssertionError()"],
                   check=True)
    print(listener.server_port, flush=True)
    listener.handle_request()
"""
        import urllib.request

        root = Path(__file__).resolve().parents[1]
        with subprocess.Popen([sys.executable, "-c", code], cwd=root, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as service:
            try:
                port = service.stdout.readline().strip()
                if not port:
                    self.fail(service.communicate(timeout=3)[1])
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(f"http://127.0.0.1:{int(port)}/", timeout=3) as response:
                    self.assertEqual(response.read(), b"guarded")
                self.assertEqual(service.wait(timeout=3), 0)
            finally:
                if service.poll() is None:
                    service.kill()
