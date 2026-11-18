import io
import json
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from packages.science.md_transport import analyze_transport


def options(mode, field, flux, **extra):
    return {"mode": mode, "columns": {"position": "x", "field": "f", "flux": "q"},
            "units": {"position": "m", "field": field, "flux": flux}, **extra}


def workbook():
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package = "http://schemas.openxmlformats.org/package/2006/relationships"
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as zipped:
        zipped.writestr("_rels/.rels", f'<Relationships xmlns="{package}">'
                       f'<Relationship Id="r1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/>'
                       "</Relationships>")
        zipped.writestr("xl/workbook.xml", f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>'
                       '<sheet name="Profile" sheetId="1" r:id="r1"/></sheets></workbook>')
        zipped.writestr("xl/_rels/workbook.xml.rels", f'<Relationships xmlns="{package}">'
                       f'<Relationship Id="r1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/>'
                       "</Relationships>")
        header = "".join(f'<c t="inlineStr"><is><t>{name}</t></is></c>' for name in ("x", "f", "q"))
        rows = ["".join(f"<c><v>{value}</v></c>" for value in entry)
                for entry in ((0, 300, -10), (1, 305, -10))]
        zipped.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{ns}"><sheetData>'
                       + "".join(f'<row r="{number}">{row}</row>'
                                 for number, row in enumerate([header, *rows], 1))
                       + "</sheetData></worksheet>")
    return buffer.getvalue()


class MDTransportTests(unittest.TestCase):
    def test_conductivity_windows_decimal_bins_and_source_rows(self):
        payload = (b"t,x,f,q,notes\n"
                   b"0,0.1,300,-4,first\n1,0.2,310,-6,inside\n"
                   b"1,0.3,320,-8,edge\n2,0.2,wrong,wrong,outside time\n"
                   b"1,0.4,wrong,wrong,outside space\n")
        config = options("conductivity", "K", "W/m^2", driving="flux_imposed",
                         bin_width=0.1, position_min=0.1, position_max=0.3,
                         time_min=0, time_max=1, source_job_id="source-7")
        config["columns"]["time"] = "t"
        config["units"].update(position="nm", time="step")
        result = analyze_transport("profile.csv", payload, config)
        self.assertEqual([item["count"] for item in result["profile"]], [1, 1, 1])
        self.assertEqual(result["mean_flux"], -6)
        self.assertAlmostEqual(result["gradient"] / 1e11, 1)
        self.assertAlmostEqual(result["coefficient"] / 6e-11, 1)
        self.assertEqual(result["selection"]["selected_count"], 3)
        self.assertEqual(result["driving"], "flux_imposed")
        self.assertEqual(result["source"]["source_job_id"], "source-7")
        self.assertEqual(result["source"]["rows"][-1],
                         {"line": 6, "values": ["1", "0.4", "wrong", "wrong", "outside space"]})
        json.dumps(result, allow_nan=False)

    def test_diffusivity_bases_and_mismatch(self):
        payload = b"x,f,q\n0,2,-2\n1,4,-2\n"
        for field, flux, basis, coefficient in (
            ("kg/m^3", "kg/(m^2*s)", "mass", 1),
            ("mol/m^3", "mol/(m^2*s)", "molar", 1),
            ("1/angstrom^3", "1/(angstrom^2*ps)", "number", 100),
        ):
            with self.subTest(basis=basis):
                result = analyze_transport("fick.csv", payload, options("diffusivity", field, flux))
                self.assertEqual(result["concentration_basis"], basis)
                self.assertAlmostEqual(result["coefficient"], coefficient)
                self.assertEqual(result["coefficient_unit"], "m^2/s")
        with self.assertRaisesRegex(ValueError, "same mass, molar, or number basis"):
            analyze_transport("fick.csv", payload, options("diffusivity", "kg/m^3", "mol/(m^2*s)"))

    def test_viscosity_stress_convention_preserves_signed_result(self):
        payload = b"x,f,q\n0,0,-4\n1,2,-4\n"
        config = options("viscosity", "m/s", "bar")
        with self.assertRaisesRegex(ValueError, "stress_convention"):
            analyze_transport("shear.csv", payload, config)
        for convention, expected in (("momentum_flux", 2e5), ("cauchy_stress", -2e5)):
            with self.subTest(convention=convention):
                result = analyze_transport("shear.csv", payload, {**config, "stress_convention": convention})
                self.assertEqual(result["coefficient"], expected)
                self.assertEqual(result["coefficient_unit"], "Pa*s")

    def test_native_chunk_with_explicit_timestep_and_metal_unit_conversion(self):
        payload = (b"# Chunk-averaged data for fix bins and group all\n"
                   b"# Timestep Number-of-chunks Total-count\n# Chunk Coord1 Ncount temp c_q[1]\n"
                   b"0 2 32\n1 -0.5 16 300 -2\n2 0.5 16 310 -2\n"
                   b"10 2 32\n1 -0.5 16 301 -1\n2 0.5 16 311 -1\n")
        config = {"mode": "conductivity",
                  "columns": {"position": "Coord1", "field": "temp", "flux": "c_q[1]", "time": "Timestep"},
                  "units": {"position": "angstrom", "field": "K", "flux": "eV/(angstrom^2*ps)",
                            "time": "step"},
                  "time_min": 10, "time_max": 10}
        result = analyze_transport("heat.profile", payload, config)
        self.assertEqual(result["source"]["format"], "lammps_ave_chunk")
        self.assertEqual(result["source"]["rows"][-1], {"line": 9, "values": ["10", "2", "0.5", "16", "311", "-1"]})
        self.assertAlmostEqual(result["coefficient"], 160.2176634)

    def test_native_ave_time_scalar_and_vector(self):
        config = options("conductivity", "K", "W/m^2")
        for payload, expected in (
            (b"# Time-averaged data for fix heat\n# TimeStep x f q\n0 0 300 -4\n10 1 302 -4\n",
             "lammps_ave_time_scalar"),
            (b"# Time-averaged data for fix heat\n# TimeStep Number-of-rows\n# Row x f q\n"
             b"0 2\n1 0 300 -4\n2 1 302 -4\n", "lammps_ave_time_vector"),
        ):
            with self.subTest(format=expected):
                result = analyze_transport("heat.dat", payload, config)
                self.assertEqual(result["source"]["format"], expected)
                self.assertEqual(result["coefficient"], 2)

    def test_xlsx_selected_sheet_without_archive_validation_pass(self):
        config = options("conductivity", "K", "W/m^2", sheet="Profile")
        with patch.object(ZipFile, "testzip", side_effect=AssertionError("unexpected archive pass")):
            result = analyze_transport("heat.xlsx", workbook(), config)
        self.assertEqual(result["source"]["sheet"], "Profile")
        self.assertEqual(result["coefficient"], 2)

    def test_undefined_gradient_and_unpaired_native_output(self):
        config = options("conductivity", "K", "W/m^2")
        with self.assertRaisesRegex(ValueError, "gradient is zero"):
            analyze_transport("heat.csv", b"x,f,q\n0,300,-1\n1,300,-1\n", config)
        with self.assertRaisesRegex(ValueError, "at least two distinct occupied positions"):
            analyze_transport("heat.csv", b"x,f,q\n0,300,-1\n0,310,-1\n", config)
        with self.assertRaisesRegex(ValueError, "named position, field and flux"):
            analyze_transport("log.lammps", b"units metal\nStep Temp Press\n1 300 1\n", config)


if __name__ == "__main__":
    unittest.main()
