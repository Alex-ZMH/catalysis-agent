"""Focused tests of the LAMMPS bundle without running LAMMPS."""
from io import BytesIO
import json
import unittest
from zipfile import ZipFile

from packages.science.md_job import build_job


POSCAR = b"""Fe/Ni
1
8 0 0
1 8 0
.5 1 8
Fe Ni
1 1
Direct
.25 .25 .25
.65 .65 .65
"""
XML = b"""<modeling>
<atominfo><array name="atoms"><set>
<rc><c>Fe</c><c>1</c></rc><rc><c>Ni</c><c>2</c></rc>
</set></array></atominfo>
<structure name="finalpos">
<crystal><varray name="basis"><v>8 0 0</v><v>1 8 0</v><v>.5 1 8</v></varray></crystal>
<varray name="positions"><v>.25 .25 .25</v><v>.65 .65 .65</v></varray>
</structure></modeling>"""
SETFL = b"""operator fixture
comment
comment
2 Fe Ni
2 .1 2 .2 .4
26 55.845 2.8 BCC
0 0
0 0
28 58.6934 3.5 FCC
0 0
0 0
0 0
0 0
0 0
"""


def lj_config(**changes):
    return dict({
        "integrator": "nve", "steps": 10, "dt_ps": .001, "initial_temperature_K": 300,
        "seed": 1701, "thermo_every": 2, "dump_every": 5, "boundary": ["p", "p", "p"],
        "force_field": {"style": "lj/cut", "cutoff_A": 3, "pairs": [
            {"i": 2, "j": 1, "epsilon_eV": .2, "sigma_A": 1.3, "cutoff_A": 2.9},
            {"i": 1, "j": 1, "epsilon_eV": .1, "sigma_A": 1.1},
            {"i": 2, "j": 2, "epsilon_eV": 0, "sigma_A": 1.5},
        ]},
    }, **changes)


class MDJobTests(unittest.TestCase):
    def test_lj_nve_bundle_contains_native_outputs_and_provenance(self):
        provenance = {"project": "p1", "run": "r1", "artifact": "a1"}
        with ZipFile(BytesIO(build_job("CONTCAR", POSCAR, lj_config(), provenance=provenance))) as bundle:
            self.assertEqual(set(bundle.namelist()), {"in.md", "structure.data", "md-config.json", "source/CONTCAR"})
            self.assertEqual(bundle.read("source/CONTCAR"), POSCAR)
            self.assertIn(b"Atoms # atomic", bundle.read("structure.data"))
            meta = json.loads(bundle.read("md-config.json"))
            self.assertEqual(meta["version"], 1)
            self.assertEqual(meta["provenance"], provenance)
            self.assertEqual(meta["files"]["source"], "source/CONTCAR")
            self.assertEqual(meta["structure"]["cell"]["tilt_A"], {"xy": 1, "xz": .5, "yz": 1})
            pairs = meta["config"]["force_field"]["pairs"]
            self.assertEqual([(pair["i"], pair["j"]) for pair in pairs], [(1, 1), (1, 2), (2, 2)])
            commands = bundle.read("in.md").decode("ascii").splitlines()
        for command in (
            "log log.lammps", "units metal", "atom_style atomic", "read_data structure.data",
            "pair_style lj/cut 3.0", "pair_coeff 1 2 0.2 1.3 2.9",
            "timestep 0.001", "velocity all create 300.0 1701 mom yes rot no dist gaussian",
            "fix md_integrator all nve", "thermo 2", "thermo_style custom step time temp pe ke etotal press",
            "dump md_trajectory all custom 5 trajectory.lammpstrj id type x y z ix iy iz vx vy vz",
            "dump_modify md_trajectory sort id units yes format float %.17g",
            "run 10", "write_data final.data", "write_restart final.restart",
        ):
            self.assertIn(command, commands)

    def test_eam_nvt_uses_operator_table_and_type_order(self):
        config = lj_config(integrator="nvt", damping_ps=.1,
                           force_field={"style": "eam/alloy", "elements": ["Fe", "Ni"]},
                           structure_options={"mass_overrides": {"Fe": 57}})
        provenance = {"potential_filename": "operator.eam.alloy"}
        with ZipFile(BytesIO(build_job("vasprun.xml", XML, config, potential=SETFL, provenance=provenance))) as bundle:
            self.assertEqual(bundle.read("potential.eam.alloy"), SETFL)
            self.assertEqual(bundle.read("source/vasprun.xml"), XML)
            commands = bundle.read("in.md")
            self.assertIn(b"pair_coeff * * potential.eam.alloy Fe Ni\nmass 1 57\n", commands)
            self.assertIn(b"fix md_integrator all nvt temp 300.0 300.0 0.1\n", commands)
            metadata = json.loads(bundle.read("md-config.json"))
            self.assertEqual(metadata["provenance"], provenance)
            self.assertEqual(metadata["files"]["potential"], "potential.eam.alloy")

    def test_rejects_incomplete_pairs_invalid_config_and_script_fragments(self):
        invalid = [
            lj_config(steps=True), lj_config(dt_ps=float("inf")), lj_config(seed=0),
            lj_config(initial_temperature_K=-1), lj_config(integrator="nvt"),
            lj_config(integrator="nvt", damping_ps=.1, initial_temperature_K=0),
            lj_config(boundary=["p", "p", "p\nrun 300"]),
            lj_config(force_field={"style": "lj/cut", "pairs": [], "cutoff_A": 3}),
            lj_config(force_field={"style": "lj/cut", "cutoff_A": 3, "pairs": [
                {"i": 1, "j": 2, "sigma_A": 1, "epsilon_eV": .1},
                {"i": 2, "j": 1, "sigma_A": 1, "epsilon_eV": .1},
                {"i": 2, "j": 2, "sigma_A": 1, "epsilon_eV": .1},
            ]}),
        ]
        for config in invalid:
            with self.subTest(config=config), self.assertRaises(ValueError):
                build_job("POSCAR", POSCAR, config)
        with self.assertRaises(ValueError):
            build_job("../POSCAR", POSCAR, lj_config())
        with self.assertRaises(ValueError):
            build_job("POSCAR", POSCAR, lj_config(), potential=SETFL)

    def test_rejects_bad_eam_mapping_or_missing_table(self):
        config = lj_config(force_field={"style": "eam/alloy", "elements": ["Fe", "Ni"]})
        with self.assertRaises(ValueError):
            build_job("POSCAR", POSCAR, config)
        config["force_field"]["elements"] = ["Fe", "Al"]
        with self.assertRaisesRegex(ValueError, "element mapping"):
            build_job("POSCAR", POSCAR, config, potential=SETFL)
        config["force_field"]["elements"] = ["Fe", "Ni\nrun 500"]
        with self.assertRaises(ValueError):
            build_job("POSCAR", POSCAR, config, potential=SETFL)

    def test_nonperiodic_axis_cannot_discard_source_image_flags(self):
        shifted = POSCAR.replace(b".25 .25 .25", b".25 .25 1.25")
        with self.assertRaisesRegex(ValueError, "nonperiodic"):
            build_job("POSCAR", shifted, lj_config(boundary=["p", "p", "f"]))
        with ZipFile(BytesIO(build_job("POSCAR", shifted, lj_config(initial_temperature_K=0)))) as bundle:
            self.assertNotIn(b"velocity all create", bundle.read("in.md"))
