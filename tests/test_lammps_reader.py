import copy
import json
import unittest

from packages.science.imports import validate_md
from packages.science.lammps import read_import


def frame(step, flags="pp ff pp", bounds="0 10\n0 8\n0 6",
          columns="id x y z", rows=("7 1 2 3",), prefix=""):
    return (f"{prefix}ITEM: TIMESTEP\n{step}\nITEM: NUMBER OF ATOMS\n{len(rows)}\n"
            f"ITEM: BOX BOUNDS {flags}\n{bounds}\nITEM: ATOMS {columns}\n"
            + "".join(f"{row}\n" for row in rows))


class LammpsReaderTests(unittest.TestCase):
    def read(self, data, options=None, ref=None):
        reference = None if ref is None else (
            "astra.json", json.dumps(ref).encode(), "raw_astra")
        result, details = read_import("run.lammpstrj", data.encode(),
                                      options, "raw_dump", reference)
        validate_md(result)
        return result["dump"], details

    def setUp(self):
        self.dump = frame(0, "xy xz yz pp ff pp",
                          "-1 11 -2\n-1 8 1\n3 9 -1",
                          "type zs id xs ys", ("2 0.5 7 0.5 0.25", "1 0 12 0 0"))
        self.dump += frame(10, "xy xz yz pp sm pp",
                           "1 13 -2\n-1 8 1\n3 9 -1",
                           "ys id xs zs", ("0.25 99 0.5 0.5", "0 7 0 0"))
        vectors = [[9, 0, 0], [-2, 8, 0], [1, -1, 6]]
        self.ref = {
            "length_unit": "angstrom", "coordinate_mode": "wrapped", "absolute_tolerance": 1e-10,
            "frames": [
                {"timestep": 10, "cell": {"origin": [3, 0, 3], "vectors": vectors,
                                          "periodic": [True, False, True],
                                          "boundary_flags": ["pp", "sm", "pp"]},
                 "atoms": [{"id": 7, "position": [3, 0, 3]}, {"id": 99, "position": [7.5, 1.5, 6]}]},
                {"timestep": 0, "cell": {"origin": [1, 0, 3], "vectors": copy.deepcopy(vectors),
                                         "periodic": [True, False, True]},
                 "atoms": [{"id": 12, "position": [1, 0, 3]}, {"id": 7, "position": [5.5, 1.5, 6]}]},
            ],
        }

    def test_tilted_scaled_independent_reference(self):
        dump, details = self.read(self.dump, {"length_unit": "angstrom"}, self.ref)
        self.assertEqual(dump["time"], {"mode": "unknown"})
        self.assertEqual(dump["frames"][1]["atoms"][0], {"id": 99, "position": [7.5, 1.5, 6]})
        self.assertEqual(details["reference_artifact_id"], "raw_astra")
        self.assertTrue(details["reference_verified"])
        self.assertEqual([(c["timestep"], c["atom_count"], c["max_abs_error"])
                          for c in details["frame_checks"]], [(0, 2, 0), (10, 2, 0)])

    def test_coordinate_families_preserve_outside_box_and_flags_change(self):
        for columns, fields, mode in (
            ("x y z", "11 -2 3", "wrapped"), ("xu yu zu", "11 -2 3", "unwrapped"),
            ("xs ys zs", "1.1 -0.25 0.5", "wrapped"),
            ("xsu ysu zsu", "1.1 -0.25 0.5", "unwrapped"),
        ):
            with self.subTest(columns=columns):
                data = frame(0, columns=f"{columns} id", rows=(f"{fields} 1",))
                data += frame(1, "pp pp ff", columns=f"id {columns}", rows=())
                dump, details = self.read(data, {"length_unit": "nm"})
                self.assertEqual(dump["coordinate_mode"], mode)
                self.assertEqual(dump["frames"][0]["atoms"][0]["position"], [11, -2, 3])
                self.assertEqual(dump["frames"][1]["cell"]["periodic"], [True, True, False])
                self.assertFalse(details["reference_verified"])
                self.assertIsNone(details["frame_checks"][0]["max_abs_error"])

    def test_unit_and_time(self):
        metallic = frame(0, prefix="ITEM: UNITS\nmetal\n")
        dump, _ = self.read(metallic, {"length_unit": "Å", "dt": 0.002, "time_origin": 1})
        self.assertEqual(dump["length_unit"], "Å")
        self.assertEqual(dump["time"], {"mode": "constant_dt", "dt": 0.002, "unit": "ps",
                                        "step_origin": 0, "time_origin": 1})
        timed = frame(0, prefix="ITEM: UNITS\nreal\nITEM: TIME\n0\n")
        timed += frame(10, prefix="ITEM: TIME\n0.53\n")
        dump, _ = self.read(timed)
        self.assertEqual(dump["time"], {"mode": "explicit", "unit": "fs"})
        self.assertEqual(dump["frames"][1]["time"], 0.53)
        dump, _ = self.read(frame(0, prefix="ITEM: TIME\n1\n"), {"length_unit": "nm"})
        self.assertEqual(dump["time"], {"mode": "unknown"})
        self.assertNotIn("time", dump["frames"][0])
        for data, options, message in (
            (metallic, {"length_unit": "nm"}, "length_unit.*conflicts"),
            (metallic, {"time_unit": "fs"}, "time_unit.*conflicts"),
            (frame(0), {}, "length_unit"),
            (frame(0), {"length_unit": "nm", "dt": 1}, "time_unit"),
            (timed + frame(20), {}, "Row time"),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.read(data, options)

    def test_malformed_and_limits(self):
        for data, options, message in (
            (frame(0).rsplit("7", 1)[0], {}, "truncated"),
            (frame(0, rows=("7 1 2 nan",)), {}, "step 0 atom id 7 axis z"),
            (frame(0, rows=("7 1 2 3", "7 4 5 6")), {}, "duplicate atom id 7"),
            (frame(0, "pf ff pp"), {}, "boundary flags"),
            (frame(0, bounds="0 0\n0 8\n0 6"), {}, "invalid box"),
            (frame(1) + frame(0), {}, "strictly increasing"),
            (frame(0), {"max_bytes": 5}, "at most 5 bytes"),
            (frame(0), {"max_line_bytes": 5}, "max_line_bytes"),
            (frame(0) + frame(1), {"max_frames": 1}, "max_frames"),
            (frame(0) + frame(1), {"max_total_atoms": 1}, "max_total_atoms"),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.read(data, {"length_unit": "angstrom", **options})

    def test_reference_mismatches(self):
        def mutate(ref, path, value):
            target = ref
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value

        for path, value, message in (
            (("length_unit",), "nm", "length_unit"),
            (("coordinate_mode",), "unwrapped", "coordinate_mode"),
            (("frames", 1, "timestep"), 4, "step missing from reference: 0"),
            (("frames", 0, "atoms", 0, "id"), 8, "step 10 atom id missing from reference: 7"),
            (("frames", 0, "atoms", 1, "position", 1), 1.6, "step 10 atom id 99 axis y"),
            (("frames", 0, "atoms", 1, "position", 1), float("inf"), "step 10 atom id 99 axis y"),
            (("frames", 0, "cell", "origin", 0), 1, "step 10 cell origin axis x"),
            (("frames", 0, "cell", "periodic", 1), True, "step 10 cell periodic axis b"),
            (("frames", 0, "cell", "boundary_flags", 1), "ff", "step 10 boundary_flags axis b"),
            (("frames", 0, "cell", "vectors", 1), [2, 8, 0], "step 10 cell vector b axis x"),
        ):
            ref = copy.deepcopy(self.ref)
            mutate(ref, path, value)
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.read(self.dump, {"length_unit": "angstrom"}, ref)

    def test_reference_tolerance_is_inclusive(self):
        self.ref["absolute_tolerance"] = 0.1
        self.ref["frames"][0]["atoms"][1]["position"][1] = 1.6
        _, details = self.read(self.dump, {"length_unit": "angstrom"}, self.ref)
        self.assertEqual(details["frame_checks"][1]["max_abs_error"], 0.1)

    def test_unit_symbols_are_case_sensitive_except_known_aliases(self):
        for declared, expected in (("Mm", "mm"), ("μM", "μm"), ("NM", "nm"), ("A", "a")):
            with self.subTest(declared=declared, expected=expected):
                self.ref["length_unit"] = expected
                with self.assertRaisesRegex(ValueError, "reference length_unit mismatch"):
                    self.read(self.dump, {"length_unit": declared}, self.ref)

        self.ref["length_unit"] = "Å"
        _, details = self.read(self.dump, {"length_unit": "angstrom"}, self.ref)
        self.assertTrue(details["reference_verified"])

        for style, options in (("nano", {"length_unit": "NM"}),
                               ("metal", {"time_unit": "PS"})):
            with self.subTest(style=style), self.assertRaisesRegex(ValueError, "conflicts"):
                self.read(frame(0, prefix=f"ITEM: UNITS\n{style}\n"), options)


if __name__ == "__main__":
    unittest.main()
