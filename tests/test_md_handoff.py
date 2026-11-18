"""Independent geometry checks for the offline VASP-to-LAMMPS handoff."""
import unittest

from packages.science.md_handoff import export_structure


def atom_rows(data):
    return [line.split() for line in data.decode("ascii").split("Atoms # atomic\n\n")[1].splitlines()]


class HandoffTests(unittest.TestCase):
    def test_rotated_skewed_slab_preserves_species_vacuum_and_images(self):
        source = b"""Slab
1
0 2 0
-3 1 0
2 -.5 20
Fe O Cl
1 1 1
Selective dynamics
Direct
-.25 1.5 .9 F F T
.125 .25 .5 T T T
0 0 0 F F F
"""
        data, meta = export_structure("POSCAR", source)
        self.assertEqual(meta["source"], {"filename": "POSCAR", "format": "poscar"})
        self.assertEqual(meta["cell"]["vectors_A"], [[2, 0, 0], [1, 3, 0], [-.5, -2, 20]])
        self.assertEqual(meta["source_selective_dynamics"][0], [False, False, True])
        self.assertEqual(meta["atom_count"], 3)
        self.assertEqual(meta["atom_type_count"], 3)
        self.assertEqual([row["symbol"] for row in meta["species"]], ["Fe", "O", "Cl"])
        self.assertEqual([row["mass"] for row in meta["species"]], [55.845, 15.999, 35.45])
        self.assertIn(b"0 20 zlo zhi\n1 -0.5 -2 xy xz yz", data)
        first, second, third = atom_rows(data)
        self.assertEqual(first[:2], ["1", "1"])
        self.assertEqual(second[:2], ["2", "2"])
        self.assertEqual(third[:2], ["3", "3"])
        self.assertEqual(first[5:], ["-1", "1", "0"])
        for actual, expected in zip(map(float, first[2:5]), (1.55, -.3, 18)):
            self.assertAlmostEqual(actual, expected)

    def test_negative_volume_cartesian_contcar_and_optional_velocity_tail(self):
        source = b"""volume scale
-192
2 0 0
0 3 0
0 0 4
O
1
Cartesian
1 1.5 1

Cartesian
0.1 0 0
"""
        data, meta = export_structure("CONTCAR", source)
        for actual, expected in zip(meta["cell"]["lengths_A"], (4, 6, 8)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(map(float, atom_rows(data)[0][2:5]), (2, 3, 2)):
            self.assertAlmostEqual(actual, expected)
        self.assertNotIn(b"Velocities", data)

    def test_cartesian_axis_scales_and_unlabeled_vasp4(self):
        source = b"legacy\n2 3 4\n1 0 0\n0 2 0\n0 0 3\n1\nK\n.5 1 1.5\n"
        with self.assertRaisesRegex(ValueError, "no species"):
            export_structure("legacy.poscar", source)
        data, meta = export_structure("legacy.poscar", source, {"species": ["Na"]})
        self.assertEqual(meta["cell"]["lengths_A"], [2, 6, 12])
        self.assertEqual(list(map(float, atom_rows(data)[0][2:5])), [1, 3, 6])

    def test_xml_uses_finalpos_and_keeps_atominfo_order(self):
        source = b"""<modeling>
<atominfo><array name="atoms"><set>
<rc><c>O</c><c>2</c></rc><rc><c>Fe_pv</c><c>1</c></rc>
</set></array><array name="atomtypes"><set>
<rc><c>1</c><c>Fe_pv</c></rc><rc><c>1</c><c>O</c></rc>
</set></array></atominfo>
<structure name="initialpos"/>
<calculation><structure/></calculation>
<structure name="finalpos">
<crystal><varray name="basis"><v>2 0 0</v><v>0 3 0</v><v>0 0 40</v></varray></crystal>
<varray name="positions"><v>.25 .5 .75</v><v>0 0 .125</v></varray>
</structure></modeling>"""
        with self.assertRaisesRegex(ValueError, "mass override"):
            export_structure("vasprun.xml", source)
        data, meta = export_structure("vasprun.xml", source, {"mass_overrides": {"Fe_pv": 56}})
        self.assertEqual(meta["source"]["format"], "vasprun.xml")
        self.assertEqual(meta["species"][0]["mass_source"], "override")
        self.assertEqual(meta["species"][0]["mass"], 56)
        self.assertEqual(atom_rows(data), [
            ["1", "2", "0.5", "1.5", "30", "0", "0", "0"],
            ["2", "1", "0", "0", "5", "0", "0", "0"],
        ])
        with self.assertRaisesRegex(ValueError, "finalpos"):
            export_structure("vasprun.xml", source.replace(b"finalpos", b"initialpos"))
        with self.assertRaisesRegex(ValueError, "DTD"):
            export_structure("vasprun.xml", b"<!DOCTYPE modeling>" + source)

    def test_rejects_bad_geometry_counts_and_masses(self):
        source = b"label\n1\n1 0 0\n0 1 0\n0 0 1\nFe\n1\nDirect\n0 0 0\n"
        cases = [
            (source.replace(b"0 0 1", b"0 0 -1"), {}, "right-handed"),
            (source.replace(b"0 0 1", b"0 0 0"), {}, "Lattice"),
            (source.replace(b"Fe\n1", b"Fe\n2"), {}, "count"),
            (source.replace(b"Direct\n0", b"Direct\nnan"), {}, "finite"),
            (source, {"mass_overrides": {"Fe": 0}}, "positive"),
            (source, {"mass_overrides": {"O": 16}}, "source species"),
        ]
        for content, options, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                export_structure("POSCAR", content, options)
