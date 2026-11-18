"""Offline acceptance cases with invented periodic energies and compositions."""

from copy import deepcopy
from unittest import TestCase

from jsonschema import ValidationError

from packages.contracts import validate_schema
from packages.science import adsorption


def example():
    def run(name, composition, energy, mesh, magnetic="nonmagnetic"):
        return {
            "structure_id": name, "composition": composition, "energy_eV": energy,
            "k_grid": mesh, "k_grid_centering": "gamma",
            "method": {
                "functional": "PBE", "cutoff_eV": 500, "dispersion": "none", "charge_e": 0,
                "pseudopotential_ids": {el: f"generic {el}" for el in composition},
                "hubbard_U_eV": {"Fe": 4} if "Fe" in composition else {},
                "occupation_scheme": "fixed" if name == "gas" else "gaussian",
                "smearing_eV": 0 if name == "gas" else 0.05,
                "magnetism": {"mode": magnetic, "spin_orbit": False, "state": name if name in
                              ("bulk", "gas") else "slab-branch-A"},
            },
            "convergence": {
                "scf_residual_eV": 1e-7, "scf_limit_eV": 1e-6,
                "max_free_force_eV_per_angstrom": 0.01, "force_limit_eV_per_angstrom": 0.02,
                "evidence_id": f"convergence-{name}",
            },
        }

    bulk = run("bulk", {"Fe": 2, "O": 2}, -25, [6, 6, 6], "collinear")
    bulk["vacuum_angstrom"] = 0
    clean = run("slab", {"Fe": 8, "O": 8}, -100, [3, 3, 1], "collinear")
    clean.update(
        bulk_structure_id="bulk", bulk_to_slab_atom_map_id="map-bulk",
        miller_indices=[0, 1, 0], termination="Fe-rich", fixed_layers_id="fixed",
        slab_thickness_angstrom=12, vacuum_angstrom=18,
        finite_size_check={"evidence_id": "size-check", "thickness_effect_eV": 0.01,
                           "vacuum_effect_eV": 0.005, "limit_eV": 0.02},
    )
    gas = run("gas", {"O": 2}, -10, [1, 1, 1], "collinear")
    gas.update(box_lengths_angstrom=[20, 20, 20],
               isolation_check={"evidence_id": "gas-check", "effect_eV": 0.002, "limit_eV": 0.01})
    first = run("ads-a", {"Fe": 8, "O": 11}, -118, [3, 3, 1], "collinear")
    first.update(clean_structure_id="slab", clean_to_adsorbed_atom_map_id="map-a",
                 fixed_layers_id="fixed", vacuum_angstrom=18, adsorbed_units=3,
                 reference_coefficients={"gas": 1.5})
    second = deepcopy(first)
    second.update(structure_id="ads-b", clean_to_adsorbed_atom_map_id="map-b", energy_eV=-114.25)
    second["convergence"]["evidence_id"] = "convergence-ads-b"
    return {"energy_unit": "eV", "adsorbate_formula": {"O": 1}, "bulk": bulk,
            "clean_slab": clean, "configurations": [first, second], "gas_references": [gas]}


def outcomes():
    # (-118 + 100 + 15)/3 = -1; (-114.25 + 100 + 15)/3 = +0.25.
    return {"results": [
        {"structure_id": name, "status": "comparable", "normalization": "per_adsorbate",
         "unit": "eV", "adsorption_energy": energy}
        for name, energy in (("ads-a", -1.0), ("ads-b", 0.25))
    ]}


class AdsorptionContracts(TestCase):
    def test_schema_and_independent_energy(self):
        inputs, results = example(), outcomes()
        validate_schema("adsorption.input.schema.json", inputs)
        validate_schema("adsorption.result.schema.json", results)
        adsorption.validate_input(inputs)
        adsorption.validate_result(results, inputs)
        results["results"][0]["adsorption_energy"] = -1.0009
        results["results"][1]["adsorption_energy"] = 0.251
        adsorption.validate_result(results, inputs)
        results["results"][0]["adsorption_energy"] = -1.0011
        with self.assertRaisesRegex(ValidationError, "disagrees"):
            adsorption.validate_result(results, inputs)

    def test_structure_chain_and_opaque_pointers(self):
        for name, value in (("bulk_structure_id", "unknown"),
                            ("bulk_to_slab_atom_map_id", "../atoms.json"),
                            ("fixed_layers_id", "file:///tmp/layers"),
                            ("bulk_structure_id", r"C:\tmp\bulk")):
            with self.subTest(name=name, value=value), self.assertRaises(ValidationError):
                inputs = example()
                inputs["clean_slab"][name] = value
                adsorption.validate_input(inputs)
        inputs = example()
        inputs["configurations"][0]["reference_coefficients"] = {"https://example.invalid/gas": 1.5}
        with self.assertRaises(ValidationError):
            validate_schema("adsorption.input.schema.json", inputs)
        results = outcomes()
        results["results"][0]["structure_id"] = "./ads-a"
        with self.assertRaises(ValidationError):
            validate_schema("adsorption.result.schema.json", results)

    def test_noncomparable_reasons_and_no_numeric_claim(self):
        inputs, results = example(), outcomes()
        failed = inputs["configurations"][1]
        failed["reference_coefficients"]["gas"] = 1
        failed["convergence"]["max_free_force_eV_per_angstrom"] = 0.2
        failed["method"]["magnetism"]["state"] = "different-branch"
        adsorption.validate_input(inputs)
        with self.assertRaisesRegex(ValidationError, "requires noncomparable"):
            adsorption.validate_result(results, inputs)
        results["results"][1] = {
            "structure_id": "ads-b", "status": "noncomparable",
            "reasons": ["unconverged", "electronic_method", "reference_stoichiometry"],
        }
        adsorption.validate_result(results, inputs)
        results["results"][1]["reasons"].pop()
        with self.assertRaisesRegex(ValidationError, "reference_stoichiometry"):
            adsorption.validate_result(results, inputs)
        results["results"][1]["adsorption_energy"] = 0.25
        with self.assertRaises(ValidationError):
            validate_schema("adsorption.result.schema.json", results)

    def test_finite_size_reference_isolation_and_slab_protocol(self):
        inputs = example()
        inputs["clean_slab"]["finite_size_check"]["thickness_effect_eV"] = 0.1
        inputs["gas_references"][0]["k_grid"] = [1, 1, 2]
        inputs["configurations"][0]["vacuum_angstrom"] = 20
        results = {"results": [
            {"structure_id": "ads-a", "status": "noncomparable",
             "reasons": ["finite_size", "reference_protocol", "slab_protocol"]},
            {"structure_id": "ads-b", "status": "noncomparable",
             "reasons": ["finite_size", "reference_protocol"]},
        ]}
        adsorption.validate_result(results, inputs)

    def test_bulk_vacuum_units_barrier_and_coverage(self):
        inputs = example()
        inputs["bulk"]["vacuum_angstrom"] = 10
        with self.assertRaises(ValidationError):
            validate_schema("adsorption.input.schema.json", inputs)
        for key, value in (("activation_energy_eV", 1.0), ("unit", "kJ/mol"),
                           ("normalization", "per_cell")):
            result = outcomes()
            result["results"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValidationError):
                validate_schema("adsorption.result.schema.json", result)
        result = outcomes()
        result["results"].pop()
        with self.assertRaisesRegex(ValidationError, "exactly once"):
            adsorption.validate_result(result, example())
