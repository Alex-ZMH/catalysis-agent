import json
import math
import unittest
from unittest.mock import patch

from packages.science.field_probe import read_import


def mesh(points, cells, point_values, cell_values):
    def numbers(values):
        return " ".join(map(str, values))

    offsets = []
    for _, ids in cells:
        offsets.append((offsets[-1] if offsets else 0) + len(ids))
    width = len(point_values[0])
    return f"""<VTKFile type="UnstructuredGrid" byte_order="LittleEndian">
  <UnstructuredGrid><Piece NumberOfPoints="{len(points)}" NumberOfCells="{len(cells)}">
    <Points><DataArray type="Float64" NumberOfComponents="3">
      {numbers(x for p in points for x in p)}
    </DataArray></Points>
    <Cells>
      <DataArray Name="connectivity" type="Int32">{numbers(i for _, ids in cells for i in ids)}</DataArray>
      <DataArray Name="offsets" type="Int32">{numbers(offsets)}</DataArray>
      <DataArray Name="types" type="UInt8">{numbers(kind for kind, _ in cells)}</DataArray>
    </Cells>
    <PointData><DataArray Name="T" type="Float64" NumberOfComponents="{width}">
      {numbers(x for row in point_values for x in row)}
    </DataArray></PointData>
    <CellData><DataArray Name="T" type="Float64">{numbers(cell_values)}</DataArray></CellData>
  </Piece></UnstructuredGrid>
</VTKFile>""".encode()


def spec(a, b, association="point", *, magnitude=False, fractions=None, count=5):
    selection = {"kind": "magnitude"} if magnitude else {"kind": "component", "index": 0}
    return {
        "a": a, "b": b, "field": {"name": "T", "association": association, "selection": selection},
        **({"count": count} if fractions is None else {"fractions": fractions}),
    }


def ref_profile(profile, values, **overrides):
    return dict(profile, values=values, unit="K", absolute_tolerance=1e-9, **overrides)


def sampled(profile):
    return [sample["value"] for sample in profile["samples"]]


def adjacent_hexes():
    points = [(x, y, z) for x in range(3) for z in (0, 1) for y in (0, 1)]
    cells = [(12, [0, 4, 5, 1, 2, 6, 7, 3]), (12, [4, 8, 9, 5, 6, 10, 11, 7])]
    return mesh(points, cells, [(300 + 10*x + 4*y - 2*z,) for x, y, z in points], [315, 335])


class FieldProbeTests(unittest.TestCase):
    def run_import(self, content, profiles=None, reference=None):
        options = {"length_unit": "m", "field_units": {"point": {"T": "K"}, "cell": {"T": "K"}}}
        if profiles is not None:
            options["profiles"] = profiles
        return read_import("mesh.vtu", content, options, "raw", reference)

    def test_hex_shared_face_discontinuity_and_outside_mask(self):
        a, b = [-1, .25, .5], [3, .25, .5]
        specs = [spec(a, b, association, count=9) for association in ("point", "cell")]
        result, details = self.run_import(adjacent_hexes(), specs)
        point, cell = result["line_profiles"]
        self.assertEqual(sampled(point), [None, None, 300, 305, 310, 315, 320, None, None])
        self.assertEqual(sampled(cell), [None, None, 315, 315, 315, 335, 335, None, None])
        self.assertEqual(details["profiles"][1]["outside_count"], 4)

    def test_reference_derivation_provenance_and_independent_order(self):
        a, b = [.25, .25, .5], [1.75, .25, .5]
        fractions = [0, .2, .4, .6, .8, 1]
        point = spec(a, b, fractions=fractions)
        cell = spec(a, b, "cell", fractions=fractions)
        expected = [ref_profile(point, [302.5, 305.5, 308.5, 311.5, 314.5, 317.5]),
                    ref_profile(cell, [315, 315, 315, 335, 335, 335])]
        reference = {"length_unit": "m", "profiles": expected}
        ref_upload = ("oracle.json", json.dumps(reference).encode(), "ref")
        result, details = self.run_import(adjacent_hexes(), reference=ref_upload)
        self.assertEqual(result["line_profiles"][0]["reference"]["reference_artifact_id"], "ref")
        self.assertEqual(details["reference_profile_count"], 2)
        result, _ = self.run_import(
            adjacent_hexes(), [spec(a, b, "cell", count=6), spec(a, b, count=6)], reference
        )
        self.assertEqual(sampled(result["line_profiles"][0]), expected[1]["values"])
        for actual, target in zip(sampled(result["line_profiles"][1]), expected[0]["values"], strict=True):
            self.assertAlmostEqual(actual, target)

    def test_reference_checks_interior_mask_and_units(self):
        line = spec([-1, 0, 0], [3, 0, 0], fractions=[0, .25, .5, .75, 1])
        oracle = ref_profile(line, [None, 300, 310, 320, None])
        for change, message in [
            ({"values": [None, 300, 999, 320, None]}, r"sample 2 .*computed=310.*reference=999"),
            ({"values": [None, 300, None, 320, None]}, r"sample 2 .*computed=310.*reference=None"),
            ({"values": [0, 300, 310, 320, None]}, r"sample 0 .*computed=None.*reference=0"),
            ({"unit": "degC"}, r"unit mismatch.*K.*degC"),
        ]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, message):
                self.run_import(adjacent_hexes(), reference={"length_unit": "m", "profiles": [dict(oracle, **change)]})

    def test_reference_unmatched_and_duplicate(self):
        line = spec([0, 0, 0], [2, 0, 0], fractions=[0, 1])
        oracle = ref_profile(line, [300, 320])
        for specs, refs, message in [
            ([dict(line, b=[1, 0, 0])], [oracle], "unmatched"),
            ([line], [oracle, oracle], "ambiguous duplicate reference"),
            ([line, line], [oracle], "ambiguous duplicate requested"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.run_import(adjacent_hexes(), specs, {"length_unit": "m", "profiles": refs})

    def test_tetra_vector_norm_is_after_interpolation_and_obeys_slanted_face(self):
        points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
        # v=(1-2x, y); opposite vertex vectors must cancel in x.
        blob = mesh(points, [(10, range(4))], [(1-2*x, y) for x, y, _ in points], [10])
        line = spec([0, .25, .25], [1, .25, .25], magnitude=True)
        result, _ = self.run_import(blob, [line])
        actual = sampled(result["line_profiles"][0])
        for value, target in zip(actual[:3], [math.hypot(1, .25), math.hypot(.5, .25), .25]):
            self.assertAlmostEqual(value, target)
        self.assertEqual(actual[3:], [None, None])

    def test_warped_skew_hex_trilinear_oracle(self):
        # x=u+v/4+vw/4, y=v, z=w. At fixed v,w a physical straight line varies u.
        corners = [(0, 0), (1, 0), (1, 1), (0, 1)]
        uvw = [(u, v, w) for w in (0, 1) for u, v in corners]
        points = [(u + v/4 + v*w/4, v, w) for u, v, w in uvw]
        blob = mesh(points, [(12, range(8))], [(16*u*v*w,) for u, v, w in uvw], [1])
        line = spec([.1875, .5, .5], [1.1875, .5, .5])
        result, _ = self.run_import(blob, [line])
        for actual, expected in zip(sampled(result["line_profiles"][0]), [0, 1, 2, 3, 4], strict=True):
            self.assertAlmostEqual(actual, expected, places=11)

    def test_skew_hex_aabb_is_not_the_sampling_domain(self):
        corners = [(0, 0), (1, 0), (1, 1), (0, 1)]
        points = [(u + v/2, v, w) for w in (0, 1) for u, v in corners]
        blob = mesh(points, [(12, range(8))], [(1,)] * 8, [8])
        line = spec([0, .5, .5], [.5, .5, .5], "cell")
        result, _ = self.run_import(blob, [line])
        self.assertEqual(sampled(result["line_profiles"][0]), [None, None, 8, 8, 8])

    def test_inclusive_relative_tolerance(self):
        line = spec([0, 0, 0], [2, 0, 0], fractions=[0, .5, 1])
        expected = dict(ref_profile(line, [300, 300, 320]), absolute_tolerance=1, relative_tolerance=.03)
        reference = {"length_unit": "m", "profiles": [expected]}
        result, _ = self.run_import(adjacent_hexes(), reference=reference)
        self.assertEqual(sampled(result["line_profiles"][0]), [300, 310, 320])
        expected["relative_tolerance"] = .029
        with self.assertRaisesRegex(ValueError, "sample 1 .*tolerance"):
            self.run_import(adjacent_hexes(), reference=reference)

    def test_spatial_tree_partitions_mesh_and_voxel_order(self):
        points = [(2*i + x, y, z) for i in range(12) for z in (0, 1) for y in (0, 1) for x in (0, 1)]
        cells = [(11, range(8*i, 8*i+8)) for i in range(12)]
        blob = mesh(points, cells, [(x*y*z,) for x, y, z in points], list(range(12)))
        profiles = [spec([20, .5, .5], [22, .5, .5], association)
                    for association in ("point", "cell")]
        result, _ = self.run_import(blob, profiles)
        point, cell = result["line_profiles"]
        self.assertEqual(sampled(point), [5, 5.125, 5.25, None, 5.5])
        self.assertEqual(sampled(cell), [10, 10, 10, None, 11])

    def test_oversized_count_and_mixed_budget_fail_before_expansion(self):
        a, b = [0, 0, 0], [2, 0, 0]
        count = spec(a, b, count=9_999)
        explicit = spec(a, b, "cell", fractions=[0, 1])
        with patch("packages.science.field_probe._profile_spec", side_effect=AssertionError("expanded")):
            with self.assertRaisesRegex(ValueError, r"profile 0.*10000"):
                self.run_import(adjacent_hexes(), [dict(count, count=10**20)])
            with self.assertRaisesRegex(ValueError, r"profile 1.*10000"):
                self.run_import(adjacent_hexes(), [count, explicit])

    def test_exact_budget_and_derived_reference_budget(self):
        a, b = [0, 0, 0], [2, 0, 0]
        count = spec(a, b, count=3)
        explicit = spec(a, b, "cell", fractions=[0, 1])
        oracle = ref_profile(spec(a, b, fractions=[0, .5, 1]), [300, 310, 320])
        cell_oracle = ref_profile(explicit, [315, 335])
        reference = {"length_unit": "m", "profiles": [oracle, cell_oracle]}
        with patch("packages.science.field_probe._MAX_TOTAL_SAMPLES", 5):
            result, _ = self.run_import(adjacent_hexes(), [count, explicit], reference)
            self.assertEqual([len(p["samples"]) for p in result["line_profiles"]], [3, 2])
        with patch("packages.science.field_probe._MAX_TOTAL_SAMPLES", 4):
            with self.assertRaisesRegex(ValueError, r"reference profile 1.*budget"):
                self.run_import(adjacent_hexes(), reference=reference)

    def test_reference_json_rejects_duplicate_keys_constants_and_wrong_levels(self):
        oracle = ref_profile(spec([0, 0, 0], [2, 0, 0], fractions=[0, 1]), [300, 320])
        valid = json.dumps({"length_unit": "m", "profiles": [oracle]})
        for source, message in [
            (valid.replace('"length_unit": "m"', '"length_unit": "m", "length_unit": "m"'), "duplicate JSON key"),
            (valid.replace('"index": 0', '"index": 0, "index": 0'), "duplicate JSON key"),
            (valid.replace("300", "NaN"), "invalid JSON constant"),
            ("[" + valid + "]", "expected a reference JSON object"),
            ('{"length_unit": "m", "profiles": {}}', "expected a nonempty profiles array"),
            ('{"length_unit": "m", "profiles": [[]]}', "expected a profile object"),
            (valid.replace('"values": [300, 320]', '"values": [[300], 320]'), "expected one finite value"),
            (valid.replace('"kind": "component"', '"kind": {"component": 0}'), "invalid component"),
            (valid.replace('"unit": "K"', '"unit": "K", "extra": {}'), "invalid reference profile keys"),
            (valid[:-1], "invalid reference JSON"),
            (valid.replace("300", "1" + "0" * 400), "expected one finite value"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.run_import(adjacent_hexes(), reference=("oracle.json", source.encode(), "ref"))

    def test_mesh_only_and_unsupported_probe_type(self):
        points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        blob = mesh(points, [(5, range(3))], [(0,), (1,), (2,)], [3])
        result, details = self.run_import(blob)
        self.assertNotIn("line_profiles", result)
        self.assertEqual(details["reference_profile_count"], 0)
        with self.assertRaisesRegex(ValueError, "unsupported VTK probe cell type 5"):
            self.run_import(blob, [spec([0, 0, 0], [1, 0, 0])])


if __name__ == "__main__":
    unittest.main()
