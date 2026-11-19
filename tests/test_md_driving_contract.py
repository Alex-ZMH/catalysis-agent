"""Offline contract tests for actual LAMMPS transport driving."""
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

from packages import md_run
from packages.science.md_job import build_job, transport_driving_metadata


POSCAR_TILTED = b"""Fe/Ni
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
POSCAR_ORTHO = POSCAR_TILTED.replace(b"1 8 0", b"0 8 0").replace(b".5 1 8", b"0 0 8")
BASE = {
    "integrator": "nve", "steps": 20, "dt_ps": .001, "initial_temperature_K": 300,
    "seed": 1701, "thermo_every": 2, "dump_every": 5, "boundary": ["p", "p", "p"],
    "force_field": {"style": "lj/cut", "cutoff_A": 3, "pairs": [
        {"i": 1, "j": 1, "epsilon_eV": .1, "sigma_A": 1.1},
        {"i": 1, "j": 2, "epsilon_eV": .2, "sigma_A": 1.3},
        {"i": 2, "j": 2, "epsilon_eV": .1, "sigma_A": 1.5},
    ]},
}


def temperature_driving():
    return {
        "enabled": True, "axis": "x",
        "temperature": {
            "mode": "thermostat_slabs", "hot_K": 350, "cold_K": 250,
            "hot_region": {"lo": 0, "hi": 1}, "cold_region": {"lo": 7, "hi": 8},
            "damping_ps": .1, "seed": 2001,
        },
    }


def concentration_driving():
    return {
        "enabled": True, "axis": "x",
        "concentration": {
            "mode": "atom_swap_reservoirs", "species": ["Fe", "Ni"],
            "regions": [
                {"name": "left", "lo": 0, "hi": 1, "every": 2,
                 "attempts": 3, "seed": 3001, "mu_eV": {"Fe": 0, "Ni": 1}},
                {"name": "right", "lo": 7, "hi": 8, "every": 2,
                 "attempts": 3, "seed": 3002, "mu_eV": {"Fe": 1, "Ni": 0}},
            ],
            "temperature_K": 300,
        },
    }


class MDDrivingContractTests(unittest.TestCase):
    def bundle(self, source, **changes):
        config = {**BASE, **changes}
        return ZipFile(BytesIO(build_job("POSCAR", source, config)))

    def test_temperature_and_concentration_emit_real_reservoir_fixes(self):
        driving = temperature_driving()
        driving["concentration"] = concentration_driving()["concentration"]
        with self.bundle(POSCAR_TILTED, transport_driving=driving) as archive:
            script = archive.read("in.md").decode("ascii")
            meta = json.loads(archive.read("md-config.json"))
        self.assertIn("group md_temperature_hot dynamic all region md_temperature_hot_region every 1", script)
        self.assertIn("fix md_hot_thermostat md_temperature_hot langevin 350 350 0.10000000000000001 2001 tally yes zero yes", script)
        self.assertIn("fix md_cold_thermostat md_temperature_cold langevin 250 250 0.10000000000000001 2002 tally yes zero yes", script)
        self.assertIn("fix md_swap_0 all atom/swap 2 3 3001 300 semi-grand yes types 1 2 mu 0 1 ke yes region md_swap_region_0", script)
        self.assertIn("fix md_swap_1 all atom/swap 2 3 3002 300 semi-grand yes types 1 2 mu 1 0 ke yes region md_swap_region_1", script)
        self.assertIn("thermo_style custom step time temp pe ke etotal press ecouple econserve f_md_hot_thermostat f_md_cold_thermostat f_md_swap_0[1] f_md_swap_0[2] f_md_swap_1[1] f_md_swap_1[2]", script)
        normalized = meta["config"]["transport_driving"]
        self.assertEqual(normalized["temperature"]["cold_seed"], 2002)
        self.assertEqual(normalized["concentration"]["membership"], "live_region")
        self.assertEqual(normalized["concentration"]["type_ids"], {"Fe": 1, "Ni": 2})
        self.assertIn("do not guarantee a target concentration", " ".join(normalized["concentration"]["limitations"]))

    def test_concentration_sampling_uses_current_type_ids(self):
        sampling = {
            "enabled": True, "sample_every": 2, "average": "one", "axis": "x", "bins": 4,
            "channels": ["mass_flux_profile"], "fields": ["concentration"],
            "species": ["Fe", "Ni"], "mass_flux_reference": "lab",
        }
        with self.bundle(POSCAR_ORTHO, transport_sampling=sampling,
                         transport_driving=concentration_driving()) as archive:
            script = archive.read("in.md").decode("ascii")
            meta = json.loads(archive.read("md-config.json"))
        self.assertIn("(type==1)*mass/", script)
        self.assertIn("(type==2)*mass/", script)
        self.assertIn("fix md_swap_0 all atom/swap", script)
        self.assertEqual(meta["config"]["transport_sampling"]["concentration_species"], ["Fe", "Ni"])

    def test_moving_walls_exclude_wall_atoms_and_keep_orthogonal_support(self):
        shear = {
            "enabled": True, "axis": "z",
            "shear": {
                "mode": "moving_walls", "tangential_axis": "x",
                "wall_regions": [
                    {"name": "lower", "lo": 0, "hi": 1, "velocity_A_per_ps": -.1},
                    {"name": "upper", "lo": 7, "hi": 8, "velocity_A_per_ps": .1},
                ],
            },
        }
        with self.bundle(POSCAR_ORTHO, boundary=["p", "p", "f"], transport_driving=shear) as archive:
            script = archive.read("in.md").decode("ascii")
            meta = json.loads(archive.read("md-config.json"))
        self.assertIn("group md_mobile subtract all md_shear_wall", script)
        self.assertIn("fix md_shear_move_0 md_shear_wall_0 move linear -0.10000000000000001 0.0 0.0 units box", script)
        self.assertIn("fix md_shear_move_1 md_shear_wall_1 move linear 0.10000000000000001 0.0 0.0 units box", script)
        self.assertIn("fix md_integrator md_mobile nve", script)
        self.assertFalse("fix md_integrator all nve" in script)
        self.assertFalse(meta["config"]["transport_driving"]["shear"]["limitations"] == [])

    def test_normalized_bundle_round_trips_through_md_run_staging(self):
        cases = (
            (POSCAR_TILTED, BASE, temperature_driving()),
            (POSCAR_TILTED, BASE, concentration_driving()),
            (POSCAR_ORTHO, {**BASE, "boundary": ["p", "p", "f"]}, {
                "enabled": True, "axis": "z", "shear": {
                    "mode": "moving_walls", "tangential_axis": "x",
                    "wall_regions": [
                        {"name": "lower", "lo": 0, "hi": 1, "velocity_A_per_ps": -.1},
                        {"name": "upper", "lo": 7, "hi": 8, "velocity_A_per_ps": .1},
                    ],
                },
            }),
        )
        for source, base, driving in cases:
            with self.subTest(mode=next(key for key in ("temperature", "concentration", "shear") if key in driving)):
                original = build_job("POSCAR", source, {**base, "transport_driving": driving})
                with TemporaryDirectory(dir="tests") as folder:
                    bundle_path = Path(folder) / "bundle.zip"
                    bundle_path.write_bytes(original)
                    name, raw, settings, potential, provenance = md_run._read_job_bundle(bundle_path)
                    stage = Path(folder) / "stage"
                    stage.mkdir()
                    md_run._stage(stage, name, raw, settings, potential, provenance)
                    rehydrated = json.loads((stage / "md-config.json").read_text())
                    staged_script = (stage / "in.md").read_bytes()
                with ZipFile(BytesIO(original)) as first:
                    first_script = first.read("in.md")
                    first_config = json.loads(first.read("md-config.json"))["config"]
                self.assertEqual(rehydrated["config"], first_config)
                self.assertEqual(staged_script, first_script)

    def test_restart_reinstates_drives_without_recreating_initial_velocity(self):
        driving = temperature_driving()
        driving["concentration"] = concentration_driving()["concentration"]
        archive_bytes = build_job("POSCAR", POSCAR_TILTED,
                                  {**BASE, "transport_driving": driving}, restarting=True)
        with ZipFile(BytesIO(archive_bytes)) as archive:
            script = archive.read("in.md").decode("ascii")
        self.assertIn("read_restart source.restart", script)
        self.assertNotIn("velocity all create", script)
        self.assertIn("fix md_hot_thermostat md_temperature_hot langevin", script)
        self.assertIn("fix md_swap_0 all atom/swap", script)
        self.assertIn("write_restart final.restart", script)

    def test_metadata_does_not_infer_a_gradient_or_peculiar_correction(self):
        with self.bundle(POSCAR_TILTED, transport_driving=temperature_driving()) as archive:
            meta = json.loads(archive.read("md-config.json"))
        driving = transport_driving_metadata(meta["config"], meta["structure"])
        self.assertIsNone(driving["measured"]["gradients"]["temperature"]["value"])
        self.assertTrue(driving["measured"]["initial_composition_is_not_a_maintained_gradient"])
        self.assertFalse(driving["injection"]["momentum"]["peculiar_velocity_correction"])
        self.assertEqual(driving["requested"]["temperature"]["hot_K"], 350.0)

    def test_rejects_sllod_double_thermostat_and_unsafe_walls(self):
        sllod = {"enabled": True, "axis": "z", "shear": {
            "mode": "sllod", "tangential_axis": "x", "wall_regions": [],
        }}
        with self.assertRaisesRegex(ValueError, "sllod"):
            build_job("POSCAR", POSCAR_ORTHO, {**BASE, "transport_driving": sllod})
        with self.assertRaisesRegex(ValueError, "integrator=nve"):
            build_job("POSCAR", POSCAR_TILTED, {**BASE, "integrator": "nvt", "damping_ps": .1,
                                                  "transport_driving": temperature_driving()})
        walls = {"enabled": True, "axis": "z", "shear": {
            "mode": "moving_walls", "tangential_axis": "x", "wall_regions": [
                {"name": "lower", "lo": 0, "hi": 1, "velocity_A_per_ps": 0},
                {"name": "upper", "lo": 7, "hi": 8, "velocity_A_per_ps": 1},
            ],
        }}
        with self.assertRaisesRegex(ValueError, "orthogonal"):
            build_job("POSCAR", POSCAR_TILTED, {**BASE, "boundary": ["p", "p", "f"], "transport_driving": walls})


if __name__ == "__main__":
    unittest.main()
