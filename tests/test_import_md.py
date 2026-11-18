import unittest
from copy import deepcopy

from jsonschema import ValidationError

from packages.contracts import validate_schema
from packages.science.imports import validate_md


def md_record():
    frame = {
        "timestep": 10,
        "cell": {
            "origin": [-1, 0, 0],
            "vectors": [[5, 0, 0], [1, 6, 0], [0, 0, 7]],
            "periodic": [True, True, False],
        },
        "atoms": [{"id": 2, "position": [0, 0, 0]}, {"id": 9, "position": [2, 3, 4]}],
    }
    later = deepcopy(frame)
    later["timestep"] = 20
    later["atoms"].reverse()
    later["atoms"][0]["position"][0] = 12
    return {
        "dump": {
            "raw_artifact_id": "artifact_dump_01",
            "length_unit": "angstrom",
            "coordinate_mode": "unwrapped",
            "frames": [frame, later],
            "time": {"mode": "constant_dt", "dt": 0.01, "unit": "ps", "time_origin": 0, "step_origin": 10},
        },
        "time_series": {
            "raw_artifact_id": "artifact_series_01",
            "time": {"mode": "explicit", "unit": "ps"},
            "columns": [{"name": "temperature", "unit": "K"}, {"name": "energy", "unit": "eV"}],
            "samples": [
                {"timestep": 15, "time": 0.15, "values": [302, -3]},
                {"timestep": 30, "time": 0.3, "values": [305, -2]},
            ],
        },
    }


class MDImportTests(unittest.TestCase):
    def test_independently_sampled_dump_and_series_with_triclinic_cell(self):
        self.assertIsNone(validate_md(md_record()))

    def test_single_streams_and_changed_atom_population(self):
        record = md_record()
        dump = record["dump"]
        dump["coordinate_mode"] = "wrapped"
        dump["frames"][1]["atoms"] = [{"id": 5, "position": [1, 2, 3]}]
        for key in record:
            with self.subTest(stream=key):
                self.assertIsNone(validate_md({key: record[key]}))

    def test_rejects_bad_structure_and_embedded_file_metadata(self):
        for path, value in (
            (("dump", "raw_artifact_id"), "file:///dump.lammpstrj"),
            (("dump", "raw_artifact_id"), "artifact_id\n"),
            (("dump", "manifest"), {}),
            (("dump", "coordinate_mode"), "scaled"),
            (("dump", "frames", 0, "cell", "periodic"), [True, False]),
            (("dump", "frames", 0, "atoms", 0, "position"), [0, 1]),
            (("dump", "frames", 0, "atoms", 0, "id"), 0),
            (("time_series", "columns", 0, "unit"), ""),
        ):
            with self.subTest(path=path, value=value):
                record = md_record()
                parent = record
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] = value
                with self.assertRaises(ValidationError):
                    validate_md(record)
        for record in ({}, {"production_verified": True}):
            with self.assertRaises(ValidationError):
                validate_md(record)

    def test_schema_pass_can_still_fail_semantic_validation(self):
        for path, value in (
            (("dump", "frames", 1, "timestep"), 10),
            (("dump", "frames", 0, "cell", "vectors"), [[5, 0, 0], [1, 6, 0], [6, 6, 0]]),
            (("time_series", "samples", 1, "time"), 0.1),
            (("dump", "frames", 0, "atoms", 1, "id"), 2),
            (("time_series", "samples", 1, "timestep"), 14),
            (("time_series", "samples", 1, "values"), [0.3]),
            (("time_series", "columns", 1, "name"), "temperature"),
        ):
            with self.subTest(path=path):
                record = md_record()
                parent = record
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] = value
                validate_schema("md.schema.json", record)
                with self.assertRaises(ValidationError):
                    validate_md(record)



    def test_unknown_physical_time_is_explicit_and_step_only(self):
        dump = md_record()["dump"]
        dump["time"] = {"mode": "unknown"}
        self.assertIsNone(validate_md({"dump": dump}))
        dump["frames"][0]["time"] = 0.1
        with self.assertRaisesRegex(ValidationError, "exactly in explicit mode"):
            validate_md({"dump": dump})
        del dump["time"]
        with self.assertRaises(ValidationError):
            validate_md({"dump": dump})

    def test_time_metadata_requires_positive_dt_or_explicit_sample_times(self):
        record = md_record()
        del record["time_series"]["samples"][0]["time"]
        with self.assertRaisesRegex(ValidationError, "exactly in explicit mode"):
            validate_md(record)
        record["dump"]["time"]["dt"] = 0
        with self.assertRaises(ValidationError):
            validate_md({"dump": record["dump"]})

    def test_explicit_frame_times_allow_variable_step_duration(self):
        dump = md_record()["dump"]
        dump["time"] = {"mode": "explicit", "unit": "ps"}
        first, second = dump["frames"]
        first["time"], second["time"] = 0.0, 0.07
        dump["frames"].append({**deepcopy(second), "timestep": 30, "time": 0.2})
        self.assertIsNone(validate_md({"dump": dump}))

    def test_shared_validator_rejects_nonfinite_coordinates(self):
        record = md_record()
        record["dump"]["frames"][0]["atoms"][0]["position"][0] = float("nan")
        with self.assertRaisesRegex(ValidationError, "finite"):
            validate_md(record)
