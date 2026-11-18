import unittest

from jsonschema import ValidationError

from packages.contracts import validate_schema
from packages.science.imports import validate_equipment


def equipment_record():
    return {
        "raw_artifact_id": "artifact_mesh_01",
        "length_unit": "m",
        "points": [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
        "cells": [{"vtk_type": 3, "point_indices": [0, 1]}, {"vtk_type": 3, "point_indices": [1, 2]}],
        "fields": [
            {
                "name": "velocity", "association": "point", "components": 3, "unit": "m/s",
                "values": [[0, 0.3, 0], [0, 0.2, 0], [0, 0.1, 0]],
            },
            {
                "name": "velocity", "association": "cell", "components": 1, "unit": "m/s",
                "values": [[4], [6]],
            },
        ],
        "line_profiles": [
            {
                "field": {
                    "name": "velocity", "association": "point", "selection": {"kind": "magnitude"},
                },
                "coordinate_frame": "mesh",
                "a": [-1, 0, 0],
                "b": [2, 0, 0],
                "unit": "m/s",
                "samples": [
                    {"fraction": 0, "value": None},
                    {"fraction": 0.5, "value": 0.3},
                    {"fraction": 1, "value": 0.1},
                ],
                "reference": {
                    "source": "user_provided", "reference_artifact_id": "artifact_reference_point",
                    "values": [None, 0.2, 0.1],
                    "unit": "m/s", "absolute_tolerance": 0.1,
                },
            },
            {
                "field": {
                    "name": "velocity", "association": "cell",
                    "selection": {"kind": "component", "index": 0},
                },
                "coordinate_frame": "mesh",
                "a": [0.2, 0, 0],
                "b": [1.8, 0, 0],
                "unit": "m/s",
                "samples": [
                    {"fraction": 0, "value": 4},
                    {"fraction": 0.75, "value": 6},
                    {"fraction": 1, "value": 6},
                ],
                "reference": {
                    "source": "user_provided", "reference_artifact_id": "artifact_reference_cell",
                    "values": [4, 6, 6],
                    "unit": "m/s", "absolute_tolerance": 0,
                },
            },
        ],
    }


class EquipmentImportTests(unittest.TestCase):
    def test_point_magnitude_and_cell_component_with_inclusive_tolerance(self):
        self.assertIsNone(validate_equipment(equipment_record()))

    def test_point_only_mesh_and_optional_reference(self):
        record = equipment_record()
        record["cells"] = []
        record["fields"].pop()
        record["line_profiles"].pop()
        del record["line_profiles"][0]["reference"]
        self.assertIsNone(validate_equipment(record))
        del record["line_profiles"]
        self.assertIsNone(validate_equipment(record))

    def test_declared_reference_requires_an_opaque_artifact_id(self):
        record = equipment_record()
        reference = record["line_profiles"][0]["reference"]
        del reference["reference_artifact_id"]
        with self.assertRaisesRegex(ValidationError, "reference_artifact_id"):
            validate_equipment(record)

        for invalid_id in ("", "evidence/reference.csv", "https://example.invalid/reference"):
            with self.subTest(reference_artifact_id=invalid_id):
                reference["reference_artifact_id"] = invalid_id
                with self.assertRaises(ValidationError) as error:
                    validate_equipment(record)
                self.assertEqual(list(error.exception.path)[-1], "reference_artifact_id")

    def test_matching_endpoints_cannot_hide_an_interior_mismatch(self):
        record = equipment_record()
        profile = record["line_profiles"][1]
        profile["samples"][1]["value"] = 5
        with self.assertRaisesRegex(ValidationError, "exceeds") as error:
            validate_equipment(record)
        self.assertEqual(list(error.exception.path), ["line_profiles", 1, "reference", "values", 1])
        profile["reference"].update(absolute_tolerance=0.4, relative_tolerance=0.1)
        self.assertIsNone(validate_equipment(record))
        profile["reference"]["relative_tolerance"] = 0.09
        with self.assertRaisesRegex(ValidationError, "exceeds"):
            validate_equipment(record)

    def test_rejects_bad_structure_and_verification_claims(self):
        for path, value in (
            (("raw_artifact_id",), "mesh/run.vtu"),
            (("source_manifest",), {}),
            (("verification_status",), "production_verified"),
            (("cells", 0, "vtk_type"), 21),
            (("fields", 0, "association"), "face"),
            (("fields", 0, "components"), 0),
            (("line_profiles", 0, "coordinate_frame"), "untransformed_sensor"),
            (("line_profiles", 0, "reference", "source"), "solver_verified"),
            (("line_profiles", 0, "reference", "absolute_tolerance"), -1),
        ):
            with self.subTest(path=path):
                record = equipment_record()
                parent = record
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] = value
                with self.assertRaises(ValidationError):
                    validate_equipment(record)

    def test_schema_pass_can_still_fail_semantic_validation(self):
        for path, value, reason in (
            (("cells", 0, "point_indices"), [0, 1, 2], "arity"),
            (("cells", 0, "point_indices", 0), 3, "missing mesh point"),
            (("fields", 1, "values"), [[1], [2], [3]], "per entity"),
            (("fields", 0, "values", 0), [1], "component count"),
            (("fields", 1, "association"), "point", "unique per association"),
            (("line_profiles", 0, "field", "name"), "unknown", "does not exist"),
            (("line_profiles", 0, "field", "association"), "cell", "requires a vector"),
            (("line_profiles", 1, "field", "selection", "index"), 1, "out of range"),
            (("line_profiles", 0, "unit"), "mm/s", "Profile unit"),
            (("line_profiles", 0, "b"), [-1, 0, 0], "distinct"),
            (("line_profiles", 0, "samples", 0, "fraction"), 0.1, "both line endpoints"),
            (("line_profiles", 0, "samples", 1, "fraction"), 0, "strictly increasing"),
            (("line_profiles", 0, "samples", 1, "value"), -0.3, "nonnegative"),
            (("line_profiles", 0, "reference", "unit"), "mm/s", "Reference unit"),
            (("line_profiles", 0, "reference", "values"), [0.2, 0.1], "per sample"),
            (("line_profiles", 0, "reference", "values", 0), 0, "masks must agree"),
        ):
            with self.subTest(path=path):
                record = equipment_record()
                parent = record
                for key in path[:-1]:
                    parent = parent[key]
                parent[path[-1]] = value
                validate_schema("equipment.schema.json", record)
                with self.assertRaisesRegex(ValidationError, reason):
                    validate_equipment(record)
