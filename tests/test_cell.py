from math import hypot
from unittest import TestCase
from unittest.mock import patch

from packages.science.cell import check_cell, plan_from_poscar


SLAB = b"""Wrapped slab
2
2 0 0
0 0 -2.5
3 10 0
Fe O
1 1
Selective dynamics
Direct
0.2 0.3 0.95 F F F
0.25 0.4 0.05 T F T
"""


class CellTests(TestCase):
    def test_full_lengths_and_effective_limits(self):
        result = check_cell([[30, 40, 0], [0, 6, 0], [0, 0, 50]], {"b": 5})
        self.assertEqual(result, {
            "lengths_A": {"a": 50, "b": 6, "c": 50},
            "limits_A": {"a": 50, "b": 5, "c": 50},
            "exceeded_axes": ["b"],
            "within_limit": False,
        })
        for rows in (
            [[1, 0, 0], [2, 0, 0], [0, 0, 1]],
            [[float("nan"), 0, 0], [0, 1, 0], [0, 0, 1]],
            [[0, 0, 0], [0, 1, 0], [0, 0, 1]],
        ):
            with self.assertRaises(ValueError):
                check_cell(rows)
        with self.assertRaisesRegex(ValueError, "at most 50"):
            check_cell([[1, 0, 0], [0, 1, 0], [0, 0, 1]], 51)

    def test_wrapped_skew_slab_preserves_geometry_and_mapping(self):
        result = plan_from_poscar(SLAB, {"repeats": [2, 1, 1], "vacuum_A": 10})
        self.assertTrue(result["within_limit"])
        self.assertAlmostEqual(result["slab_thickness_A"], 2)
        self.assertAlmostEqual(result["actual_vacuum_A"], 10)
        self.assertEqual(result["atom_count"], 4)
        lines = result["poscar"].splitlines()
        self.assertEqual(lines[5:9], ["Fe O", "2 2", "Selective dynamics", "Direct"])
        rows = [list(map(float, line.split())) for line in lines[2:5]]
        self.assertEqual(rows[:2], [[8, 0, 0], [0, 0, -5]])
        for actual, expected in zip(rows[2], [6, 12, 0]):
            self.assertAlmostEqual(actual, expected)
        atoms = []
        for line, flags in zip(lines[9:], ["F F F", "F F F", "T F T", "T F T"]):
            xyz = line.split()
            self.assertEqual(" ".join(xyz[3:]), flags)
            atoms.append([sum(float(x) * row[i] for x, row in zip(xyz, rows))
                          for i in range(3)])
        for axis, expected in enumerate([0.8, 2, -0.5]):
            self.assertAlmostEqual(atoms[2][axis] - atoms[0][axis], expected)
        self.assertAlmostEqual(atoms[0][1], 5)
        self.assertAlmostEqual(atoms[1][0] - atoms[0][0], 4)
        self.assertEqual(result["atom_mapping"], [
            {"source_index": source, "image": [i, 0, 0]}
            for source in range(2) for i in range(2)
        ])

    def test_final_skew_length_excludes_candidate(self):
        result = plan_from_poscar(SLAB, {"vacuum_A": 48})
        self.assertEqual(result["exceeded_axes"], ["c"])
        self.assertAlmostEqual(result["lengths_A"]["c"], hypot(6, 50))
        self.assertNotIn("poscar", result)

    def test_cartesian_scale_and_c_replication_without_replacement(self):
        cartesian = SLAB.replace(
            b"Direct\n0.2 0.3 0.95 F F F\n0.25 0.4 0.05 T F T",
            b"Cartesian\n3.25 9.5 -0.75 F F F\n0.65 0.5 -1.0 T F T",
        )
        options = {"repeats": [1, 1, 2]}
        direct = plan_from_poscar(SLAB, options)
        actual = plan_from_poscar(cartesian, options)
        self.assertEqual(actual["lengths_A"], direct["lengths_A"])
        self.assertAlmostEqual(actual["slab_thickness_A"], 4)
        self.assertAlmostEqual(actual["actual_vacuum_A"], 36)
        for left, right in zip(actual["poscar"].splitlines()[9:],
                               direct["poscar"].splitlines()[9:]):
            for a, b in zip(left.split()[:3], right.split()[:3]):
                self.assertAlmostEqual(float(a), float(b))

    def test_ambiguous_and_unsupported_inputs(self):
        tied = SLAB.replace(b"0.3 0.95", b"0.3 0.55")
        with self.assertRaisesRegex(ValueError, "multiple largest"):
            plan_from_poscar(tied, {"vacuum_A": 10})
        with self.assertRaisesRegex(ValueError, "c repeat 1"):
            plan_from_poscar(SLAB, {"vacuum_A": 10, "repeats": [1, 1, 2]})
        with self.assertRaisesRegex(ValueError, "trailing"):
            plan_from_poscar(SLAB + b"\n0 0 0\n", {})
        with self.assertRaisesRegex(ValueError, "scale factor"):
            plan_from_poscar(SLAB.replace(b"\n2\n", b"\n-2\n", 1), {})

    def test_ordered_limits(self):
        result = plan_from_poscar(SLAB, {"limits_A": [4, 4.5, 30]})
        self.assertEqual(result["limits_A"], {"a": 4, "b": 4.5, "c": 30})
        self.assertEqual(result["exceeded_axes"], ["b"])
        self.assertNotIn("poscar", result)
        with self.assertRaisesRegex(ValueError, "must contain"):
            plan_from_poscar(SLAB, {"limits_A": [4, 5]})

    def test_left_handed_poscar_is_rejected(self):
        left_handed = SLAB.replace(b"0 0 -2.5", b"0 0 2.5")
        with self.assertRaisesRegex(ValueError, "right-handed"):
            plan_from_poscar(left_handed, {})

    def test_atom_count_limit_precedes_replica_generation(self):
        tiny = SLAB.replace(b"\n2\n", b"\n1e-12\n", 1)
        with patch.dict("os.environ", {"CATALYSIS_MAX_MODEL_ATOMS": "4"}):
            self.assertEqual(plan_from_poscar(tiny, {"repeats": [2, 1, 1]})["atom_count"], 4)
            with patch("packages.science.cell.product") as generate:
                with self.assertRaisesRegex(ValueError, "CATALYSIS_MAX_MODEL_ATOMS=4"):
                    plan_from_poscar(tiny, {"repeats": [10**12, 1, 1]})
                generate.assert_not_called()
        with patch.dict("os.environ", {"CATALYSIS_MAX_MODEL_ATOMS": "0"}):
            with self.assertRaisesRegex(ValueError, "must be a positive integer"):
                plan_from_poscar(tiny, {})
