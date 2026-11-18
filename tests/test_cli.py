import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from packages.check import artifact_links, main
from test_adsorption_contracts import example as adsorption_input, outcomes as adsorption_result
from test_kinetics_contracts import arrhenius
from test_records import example_run


class LocalEntryPoint(unittest.TestCase):
    def test_paired_analysis_bytes_and_run_evidence(self):
        for kind, operation, (source, result) in [
            ("adsorption", "adsorption.compare", (adsorption_input(), adsorption_result())),
            ("kinetics", "kinetics.fit", arrhenius()),
        ]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                doc, input_file, manifest = [Path(directory) / name for name in
                                             ("result.json", "input.json", "run.json")]
                doc.write_bytes(json.dumps(result).encode())
                input_file.write_bytes(json.dumps(source).encode())
                run = example_run() | {"operation": operation}
                normalized, output = run["artifacts"][1:]
                for artifact, path in [(normalized, input_file), (output, doc)]:
                    raw = path.read_bytes()
                    artifact.update(size_bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
                links = sorted(set(artifact_links(source)) | set(artifact_links(result)))
                for key in links:
                    data = key.encode()
                    run["artifacts"].append(dict(normalized, artifact_id=key,
                                                 size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
                normalized.update(role="derived", parents=links)
                manifest.write_text(json.dumps(run), encoding="utf-8")
                args = [kind, str(doc), "--input", str(input_file), "--run", str(manifest)]
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(main(args), 0)
                with redirect_stderr(io.StringIO()):
                    original = input_file.read_bytes()
                    input_file.write_bytes(original + b" ")
                    self.assertEqual(main(args), 1)
                    input_file.write_bytes(original)
                    missing = "gas" if kind == "adsorption" else "reading-0"
                    normalized["parents"].remove(missing)
                    run["artifacts"] = [a for a in run["artifacts"] if a["artifact_id"] != missing]
                    manifest.write_text(json.dumps(run), encoding="utf-8")
                    self.assertEqual(main(args), 1)

    def test_offline_profile_and_malformed_json(self):
        profile = Path(__file__).resolve().parents[1] / "configs/profiles/intranet.json"
        with patch("socket.socket.connect", side_effect=AssertionError("Unexpected network access")):
            with redirect_stdout(io.StringIO()):
                self.assertEqual(main(["profile", str(profile)]), 0)
            with tempfile.TemporaryDirectory() as directory, redirect_stderr(io.StringIO()):
                payload = Path(directory) / "record.json"
                payload.write_text('{"project_id":"old","project_id":"new"}', encoding="utf-8")
                self.assertEqual(main(["run", str(payload)]), 1)

    def test_import_must_match_declared_bytes_and_evidence(self):
        # A small normalized point-data record is sufficient to exercise the entire CLI.
        payload = dict(raw_artifact_id="raw", length_unit="m",
                       points=[[0, 0, 0], [1, 0, 0]], cells=[dict(vtk_type=3, point_indices=[0, 1])],
                       fields=[dict(name="temperature", association="point", unit="K",
                                    components=1, values=[[300], [301]])])
        def attach(run, raw):
            run["artifacts"][-1].update(size_bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            doc, manifest = root / "field.json", root / "run.json"
            run = example_run() | {"operation": "equipment.import"}
            def write():
                doc.write_bytes(json.dumps(payload).encode())
                attach(run, doc.read_bytes())
                manifest.write_text(json.dumps(run), encoding="utf-8")

            write()
            argv = ["equipment", str(doc), "--run", str(manifest)]
            with redirect_stdout(io.StringIO()):
                self.assertEqual(main(argv), 0)
            with redirect_stderr(io.StringIO()):
                doc.write_bytes(doc.read_bytes() + b" ")
                self.assertEqual(main(argv), 1)
                payload["raw_artifact_id"] = "unrelated"
                write()
                self.assertEqual(main(argv), 1)
                payload["raw_artifact_id"] = "raw"
                run["operation"] = "md.import"
                write()
                self.assertEqual(main(argv), 1)
