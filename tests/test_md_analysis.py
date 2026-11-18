import unittest

from packages.science.md_analysis import analyze_msd, analyze_thermo


def frame(step, columns, rows, *, time=None, bounds="pp pp pp\n0 10\n0 10\n0 10"):
    timestamp = "" if time is None else f"ITEM: TIME\n{time}\n"
    return (f"{timestamp}ITEM: TIMESTEP\n{step}\nITEM: NUMBER OF ATOMS\n{len(rows)}\n"
            f"ITEM: BOX BOUNDS {bounds}\nITEM: ATOMS {columns}\n"
            + "\n".join(rows) + "\n")


class MDAnalysisTests(unittest.TestCase):
    def msd(self, text, **options):
        return analyze_msd("trajectory.lammpstrj", text.encode(), options)

    def test_restricted_triclinic_images_and_timestep(self):
        bounds = "xy xz yz pp pp pp\n-1 14 -2\n1 10 3\n3 9 -1"
        columns = "id x y z ix iy iz"
        dump = "ITEM: UNITS\nmetal\n"
        dump += frame(100, columns, ["1 4 5 6 0 0 0"], bounds=bounds)
        dump += frame(110, columns, ["1 4 5 6 2 -1 1"], bounds=bounds)
        result = self.msd(dump, timestep_ps=0.01)
        self.assertEqual(result["rows"], [{"step": 100, "time_ps": 0.0, "msd_a2": 0.0},
                                          {"step": 110, "time_ps": 0.1, "msd_a2": 742.0}])
        self.assertEqual(result["time_origin"]["step"], 100)
        self.assertEqual(result["unwrapping_method"], "cartesian_image_flags")
        self.assertEqual(result["coordinate_mode"], "unwrapped")
        self.assertAlmostEqual(result["fit"]["diffusion_a2_per_ps"], 7420 / 6)

    def test_general_triclinic_scaled_unwrapped_with_changing_origin(self):
        columns = "id xsu ysu zsu"
        dump = frame(0, columns, ["1 0.25 0.5 0.75"],
                     bounds="abc origin\n0 4 0 10\n-3 1 0 20\n1 0 6 30")
        dump += frame(2, columns, ["1 1.25 -0.5 1.75"],
                      bounds="abc origin\n0 4 0 11\n-3 1 0 18\n1 0 6 33")
        result = self.msd(dump, unit_style="metal", timestep_ps=0.5, axes="xy")
        self.assertEqual(result["rows"][1]["msd_a2"], 26)
        self.assertEqual(result["unwrapping_method"], "scaled_unwrapped")
        self.assertEqual(result["fit"]["diffusion_a2_per_ps"], 6.5)

    def test_native_real_time_and_negative_window_fit_with_intercept(self):
        dump = "ITEM: UNITS\nreal\n"
        for step, stamp, x in ((0, 5000, 0), (100, 5250, 4), (300, 6000, 3), (930, 7000, 2)):
            dump += frame(step, "id xu yu zu", [f"1 {x} 70 -20"], time=stamp)
        result = self.msd(dump, axes="x", fit_start_ps=1, fit_end_ps=2)
        self.assertEqual([row["time_ps"] for row in result["rows"]], [0, 0.25, 1, 2])
        self.assertEqual(result["time_origin"]["native_time_ps"], 5)
        self.assertEqual(result["time_source"], "item_time")
        self.assertEqual(result["fit"], {
            "start_ps": 1, "end_ps": 2, "n_points": 2, "slope_a2_per_ps": -5,
            "intercept_a2": 14, "diffusion_a2_per_ps": -2.5, "diffusion_m2_per_s": -2.5e-8,
        })

    def test_fixed_group_intersection_and_drift_weighting(self):
        large_id = "9007199254740993"
        columns = "id type xu yu zu"
        dump = frame(0, columns, [f"{large_id} 3 0 0 0", "2 2 2 0 0", "3 1 4 0 0", "4 2 6 0 0"])
        dump += frame(1, columns, ["4 2 40 0 0", "3 1 -10 0 0", "2 2 9 0 0", f"{large_id} 3 3 0 0"])
        options = {"unit_style": "metal", "timestep_ps": 1, "axes": "x",
                   "atom_ids": [large_id, "2", "3"], "atom_types": ["2", "3"]}
        plain = self.msd(dump, **options)
        equal = self.msd(dump, **options, remove_drift=True)
        weighted = self.msd(dump, **options, remove_drift=True, masses_by_type={"2": 3, "3": 1})
        self.assertEqual(plain["selection"]["selected_atom_ids"], ["2", large_id])
        self.assertEqual(plain["selection"]["mode"], "intersection")
        self.assertEqual(plain["rows"][1]["msd_a2"], 29)
        self.assertEqual(equal["drift_weighting"], "equal")
        self.assertEqual(equal["rows"][1]["msd_a2"], 4)
        self.assertEqual(weighted["drift_weighting"], "masses_by_type")
        self.assertEqual(weighted["rows"][1]["msd_a2"], 5)

    def test_missing_coordinate_fields_or_time_are_explicit(self):
        for columns, row in (("id x y z", "1 0 0 0"), ("id xu yu", "1 0 0")):
            with self.subTest(columns=columns), self.assertRaisesRegex(ValueError, "unwrapped coordinates"):
                self.msd(frame(0, columns, [row]), unit_style="metal", timestep_ps=1, axes="x")
        with self.assertRaisesRegex(ValueError, "timestep_ps"):
            self.msd(frame(0, "id xu yu zu", ["1 0 0 0"]), unit_style="metal")

    def test_thermo_preserves_rows_and_run_boundaries(self):
        log = (b"units metal\nStep Time Temp PotEng Press\n0 0 100 -4 5\n10 .01 101 -3 6\n"
               b"Loop time of 0.001\nStep Time Temp PotEng Press\n10 .01 101 -3 6\n")
        result = analyze_thermo("log.lammps", log, {})
        ranges = [{"start_row": 0, "end_row": 2}, {"start_row": 2, "end_row": 3}]
        self.assertEqual(result["blocks"], ranges)
        self.assertEqual(result["units"], {"Step": "step", "Time": "ps", "Temp": "K",
                                           "PotEng": "eV", "Press": "bar"})
        self.assertEqual([row["Step"] for row in result["rows"]], [0, 10, 10])
        jsonl = b'{"Step":0,"Time":0,"PotEng":-4,"Press":5}\n{"Step":10}\n{"Step":0}\n'
        with self.assertRaisesRegex(ValueError, "unit_style"):
            analyze_thermo("thermo.jsonl", jsonl, {})
        result = analyze_thermo("thermo.jsonl", jsonl, {"unit_style": "real"})
        self.assertEqual(result["blocks"], ranges)
        self.assertEqual(result["units"], {"Step": "step", "Time": "fs",
                                           "PotEng": "kcal/mol", "Press": "atm"})


if __name__ == "__main__":
    unittest.main()
