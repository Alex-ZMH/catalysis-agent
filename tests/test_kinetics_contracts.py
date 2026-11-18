"""Offline acceptance cases using analytic, invented kinetic datasets."""

from math import exp
from unittest import TestCase

from jsonschema import ValidationError

from packages.contracts import validate_schema
from packages.science import kinetics


def row(index, batch, temperature, value, partition="train"):
    return {"observation_id": f"obs-{index}", "condition_id": f"condition-{index}",
            "batch_id": batch, "evidence_id": f"reading-{index}", "temperature_K": temperature,
            "value": value, "partition": partition, "quality": "accepted",
            "relative_uncertainty": 0.03}


def results(inputs, rank, scope, warnings, **parameters):
    return {"model": inputs["model"], "source": "synthetic", "design_rank": rank,
            "validation_scope": scope, "warnings": warnings, "train_log_rmse": 0,
            "holdout_log_rmse": 0, "parameter_uncertainty": {
                "status": "unavailable", "reason": "Analytic fixture has no sampled parameter uncertainty"
            }, "residuals": [{"observation_id": item["observation_id"], "log_residual": 0}
                             for item in inputs["observations"]], **parameters}


def arrhenius():
    # k(400 K) x exp(6000 x (1/400 - 1/T)), with k(400 K) = 0.1 s^-1.
    def value(t):
        return 0.1 * exp(15 - 6000 / t)

    inputs = {"model": "arrhenius_known_k", "source": "synthetic", "response_unit": "s^-1",
              "acceptance": {"max_train_log_rmse": 0.01, "max_holdout_log_rmse": 0.03},
              "observations": [row(0, "batch-a", 350, value(350)),
                               row(1, "batch-a", 400, 0.1),
                               row(2, "batch-a", 500, value(500)),
                               row(3, "batch-b", 400, 0.1 * exp(-0.02), "holdout")]}
    output = results(inputs, 2, "independent_batch_repeatability", ["single_training_batch"],
                     prefactor=0.1 * exp(15), prefactor_unit="s^-1",
                     activation_energy=49886.77570891944, activation_energy_unit="J/mol")
    output["holdout_log_rmse"] = output["residuals"][-1]["log_residual"] = 0.02
    return inputs, output


def power_law():
    # r = 2 A^1.5 B^-1, with concentrations scaled by 1 mol/L.
    points = [(1, 1, 2), (4, 1, 16), (1, 2, 1), (4, 2, 8), (9, 3, 18)]
    observations = []
    for index, (a, b, rate) in enumerate(points):
        batch = "batch-a" if index < 2 else "batch-b"
        partition = "train"
        if index == 4:
            batch, partition = "batch-c", "holdout"
        item = row(index, batch, 320, rate, partition)
        item.update(concentrations={"A": a, "B": b}, conversion_fraction=0.02)
        observations.append(item)
    inputs = {"model": "initial_rate_power_law", "source": "synthetic", "response_unit": "mol/L/s",
              "concentration_unit": "mol/L", "temperature_K": 320, "reactants": ["A", "B"],
              "max_conversion_fraction": 0.05,
              "acceptance": {"max_train_log_rmse": 0.01, "max_holdout_log_rmse": 0.01},
              "observations": observations}
    output = results(inputs, 3, "independent_batch_new_conditions", [], orders={"A": 1.5, "B": -1},
                     reference_concentration_mol_L=1, rate_at_reference=2,
                     rate_at_reference_unit="mol/L/s")
    return inputs, output


class KineticsContracts(TestCase):
    def test_models_and_reference_values(self):
        for fixture in (arrhenius, power_law):
            with self.subTest(fixture=fixture.__name__):
                inputs, result = fixture()
                validate_schema("kinetics.input.schema.json", inputs)
                validate_schema("kinetics.result.schema.json", result)
                kinetics.validate_input(inputs)
                kinetics.validate_result(result, inputs)

    def test_initial_rate_bases_must_match(self):
        units = ("mol/L/s", "mol/(kg_cat*s)", "mol/(m2_cat*s)")
        for index, unit in enumerate(units):
            with self.subTest(unit=unit):
                inputs, result = power_law()
                inputs["response_unit"] = result["rate_at_reference_unit"] = unit
                validate_schema("kinetics.input.schema.json", inputs)
                validate_schema("kinetics.result.schema.json", result)
                kinetics.validate_result(result, inputs)

                result["rate_at_reference_unit"] = units[(index + 1) % len(units)]
                validate_schema("kinetics.result.schema.json", result)
                with self.assertRaisesRegex(ValidationError, "same basis"):
                    kinetics.validate_result(result, inputs)

    def test_training_only_identifiable_single_batch(self):
        inputs, result = arrhenius()
        inputs["observations"] = inputs["observations"][:2]
        inputs["acceptance"].pop("max_holdout_log_rmse")
        result["residuals"] = result["residuals"][:2]
        result["holdout_log_rmse"] = None
        result["validation_scope"] = "training_only"
        result["warnings"] = ["single_training_batch", "no_holdout", "no_condition_residual_dof"]
        kinetics.validate_result(result, inputs)
        result["validation_scope"] = "independent_batch_repeatability"
        with self.assertRaisesRegex(ValidationError, "scope"):
            kinetics.validate_result(result, inputs)
        result["validation_scope"] = "training_only"
        result["holdout_log_rmse"] = 0
        with self.assertRaisesRegex(ValidationError, "must be null"):
            kinetics.validate_result(result, inputs)

    def test_holdout_leakage_and_order_identifiability(self):
        inputs, result = arrhenius()
        inputs["observations"][-1]["batch_id"] = "batch-a"
        with self.assertRaisesRegex(ValidationError, "disjoint"):
            kinetics.validate_result(result, inputs)
        inputs, result = power_law()
        for index, item in enumerate(inputs["observations"][:-1], 1):
            item["concentrations"] = {"A": index, "B": index ** 2}
        with self.assertRaisesRegex(ValidationError, "rank deficient"):
            kinetics.validate_result(result, inputs)

    def test_holdout_error_residual_integrity_and_source(self):
        inputs, result = arrhenius()
        inputs["acceptance"]["max_holdout_log_rmse"] = 0.01
        with self.assertRaisesRegex(ValidationError, "exceeds"):
            kinetics.validate_result(result, inputs)
        inputs, result = arrhenius()
        result["residuals"][-1]["log_residual"] = 0
        with self.assertRaisesRegex(ValidationError, "Residual for obs-3"):
            kinetics.validate_result(result, inputs)
        result["source"] = "experimental"
        with self.assertRaisesRegex(ValidationError, "source"):
            kinetics.validate_result(result, inputs)

    def test_parameter_intervals_and_opaque_evidence(self):
        inputs, result = power_law()
        result["parameter_uncertainty"] = {
            "status": "reported", "method": "invented acceptance fixture", "evidence_id": "intervals",
            "confidence_level": 0.95,
            "intervals": {"rate_at_reference": {"lower": 1, "upper": 3},
                          "order:A": {"lower": 1, "upper": 2},
                          "order:B": {"lower": -2, "upper": 0}},
        }
        kinetics.validate_result(result, inputs)
        result["parameter_uncertainty"]["intervals"]["order:B"]["upper"] = -1.1
        with self.assertRaisesRegex(ValidationError, "bracket"):
            kinetics.validate_result(result, inputs)
        result["parameter_uncertainty"]["evidence_id"] = "https://example.invalid/intervals"
        with self.assertRaises(ValidationError):
            validate_schema("kinetics.result.schema.json", result)
        inputs["observations"][0]["evidence_id"] = "measurements/rates.csv"
        with self.assertRaises(ValidationError):
            validate_schema("kinetics.input.schema.json", inputs)

    def test_quality_units_and_candidate_parameters(self):
        for key, value, message in (("conversion_fraction", 0.06, "conversion"),
                                    ("temperature_K", 321, "fixed temperature")):
            inputs, result = power_law()
            inputs["observations"][0][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValidationError, message):
                kinetics.validate_result(result, inputs)
        inputs, result = arrhenius()
        result["prefactor_unit"] = "L/mol/s"
        with self.assertRaisesRegex(ValidationError, "same units"):
            kinetics.validate_result(result, inputs)
        inputs["observations"][0]["quality"] = "rejected"
        with self.assertRaises(ValidationError):
            validate_schema("kinetics.input.schema.json", inputs)
