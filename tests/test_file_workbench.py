"""Start from original file bytes and follow both API and disk provenance."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from http.client import HTTPConnection
import json
import math
from pathlib import Path
import tempfile
import threading
import unittest

from apps.server import make_server
from packages.agent.workspace import Workspace
from packages.check import link_result
from packages.science.kinetics import GAS_CONSTANT_J_PER_MOL_K
from test_fit_import import demo, demo_xlsx


def post_file(port, filename, content, fields, uri="/api/runs", origin=None):
    boundary = "----catalysis-fixture-abc123"
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(),
                  content, f'\r\n--{boundary}--\r\n'.encode()])
    headers = {"Content-Type": "multipart/form-data; boundary=" + boundary}
    if origin:
        headers["Origin"] = origin
    conn = HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        conn.request("POST", uri, body=b"".join(parts), headers=headers)
        response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally:
        conn.close()


class FileWorkbench(unittest.TestCase):
    def test_independent_power_law_oracle_with_custom_headers(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = Workspace(folder, "project", "analyst", "1" * 40)
            text = "temp,rate,lot,X,Y,conversion,partition\n"
            for i, (x, y) in enumerate(((0.5, 1), (1, 1), (2, 0.5), (2, 2), (4, 3), (1, 3))):
                split = "train" if i < 5 else "holdout"
                text += f"320,{0.74*x**1.37*y**-0.62:.16g},{'B' if i<5 else 'C'},{x},{y},0.02,{split}\n"
            options = dict(model="initial_rate_power_law", temperature_unit="K",
                           response_unit="mol/(kg_cat*s)", columns={
                               "temperature":"temp", "batch_id":"lot", "concentrations":{"X":"X","Y":"Y"}})
            view = ws.analyze("kinetics", "反应批次.csv", text.encode(), options, "synthetic")
            fit = view["result"]
            for measured, expected in ((fit["orders"]["X"], 1.37), (fit["orders"]["Y"], -0.62),
                                       (fit["rate_at_reference"], 0.74)):
                self.assertAlmostEqual(measured / expected, 1, delta=0.001)
            self.assertLess(fit["holdout_log_rmse"], 1e-10)
            self.assertEqual(view["details"]["measurement_uncertainty"]["available_rows"], 0)

    def test_csv_noiseless_oracle_and_concurrent_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            ws = Workspace(folder, "project", "analyst", "1" * 40)
            A, barrier = 4.37e8, 37125.0
            temperatures = (301, 313, 335, 361, 379)
            text = "temperature_K,value,batch_id,relative_uncertainty\n" + "".join(
                f"{t},{A * math.exp(-barrier / (GAS_CONSTANT_J_PER_MOL_K * t)):.16g},B,0.02\n"
                for t in temperatures)
            data = text.encode()
            def analyze(_):
                return ws.analyze("kinetics", "known.csv", data, {}, "synthetic")

            with ThreadPoolExecutor(max_workers=2) as pool:
                one, two = pool.map(analyze, range(2))
            self.assertEqual(one["id"], two["id"])
            self.assertEqual(len(ws.recent()), 1)
            self.assertAlmostEqual(one["result"]["activation_energy"] / barrier, 1, delta=0.001)
            self.assertAlmostEqual(one["result"]["prefactor"] / A, 1, delta=0.001)
            again = Workspace(folder, "project", "analyst", "1" * 40)
            self.assertEqual(again.detail(one["id"]), one)
            self.assertEqual(again.download(one["id"], one["raw_id"]), ("known.csv", data))
            other = Workspace(folder, "second", "analyst", "1" * 40)
            with self.assertRaises(FileNotFoundError):
                other.detail(one["id"])
            checksum = sha256(data).hexdigest()
            (ws.blobs / checksum[:2] / checksum).write_bytes(b"broken")
            with self.assertRaisesRegex(ValueError, "校验"):
                ws.download(one["id"], one["raw_id"])

    def test_browser_protocol_real_files_and_readback(self):
        from test_vasp_import import demo as demo_vasp
        with tempfile.TemporaryDirectory() as folder, make_server(folder, "qa", "Astra", 0) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                for kind, fixture in [("adsorption", demo_vasp), ("kinetics", demo), ("kinetics", demo_xlsx)]:
                    with self.subTest(case=fixture.__name__, kind=kind):
                        filename, content, options = fixture()
                        status, view = post_file(server.server_port, filename, content,
                                                dict(kind=kind, origin="synthetic", options=json.dumps(options)))
                        self.assertEqual(status, 200, view.get("error"))
                        self.assertEqual(view["filename"], filename)
                        raw = next(a for a in view["artifacts"] if a["id"] == view["raw_id"])
                        self.assertEqual(raw["sha256"], sha256(content).hexdigest())
                        def get(uri):
                            connection = HTTPConnection("127.0.0.1", server.server_port)
                            try:
                                connection.request("GET", uri)
                                response = connection.getresponse()
                                self.assertEqual(response.status, 200)
                                return response.read()
                            finally:
                                connection.close()
                        self.assertEqual(get(raw["url"]), content)
                        source, candidate = (next(a for a in view["artifacts"] if a["name"] == filename)
                                             for filename in ("normalized.json", "result.json"))
                        link_result(kind, view["result"], get(candidate["url"]),
                                    json.loads(get(view["manifest_url"])), view["input"], get(source["url"]))
                self.assertEqual(len(server.workspace.recent()), 3)
                status, _ = post_file(server.server_port, "empty.csv", b"bad", dict(kind="kinetics", origin="synthetic"))
                self.assertGreaterEqual(status, 400)
                self.assertLess(status, 500)
                self.assertEqual(len(server.workspace.recent()), 3)
                status, _ = post_file(server.server_port, "test.csv", b"x", {}, origin="http://other.invalid")
                self.assertEqual(status, 403)
            finally:
                server.shutdown()
                worker.join()
