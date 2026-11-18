"""Validate candidate Arrhenius and initial-rate power-law results offline."""

import math

from .validation import require, validate_payload


GAS_CONSTANT_J_PER_MOL_K = 8.31446261815324


def _features(instance, row):
    if instance["model"] == "arrhenius_known_k":
        return [1 / row["temperature_K"]]
    return [math.log(row["concentrations"][key]) for key in instance["reactants"]]


def _rank(rows):
    """Estimate design rank with centered, scaled columns and reorthogonalization."""
    basis = []
    for column in zip(*rows):
        scale = max(abs(value) for value in column)
        if not scale:
            continue
        scaled = [value / scale for value in column]
        center = math.fsum(scaled) / len(scaled)
        residual = [value - center for value in scaled]
        norm = math.hypot(*residual)
        if norm <= 1e-12 * math.sqrt(len(residual)):
            continue
        residual = [value / norm for value in residual]
        for _ in range(2):
            for vector in basis:
                projection = math.fsum(x * y for x, y in zip(residual, vector))
                residual = [x - projection * y for x, y in zip(residual, vector)]
        norm = math.hypot(*residual)
        if norm > 1e-10:
            basis.append([value / norm for value in residual])
    return 1 + len(basis)


def _validate_design(instance):
    validate_payload("kinetics.input.schema.json", instance)
    observations = instance["observations"]
    ids = {row["observation_id"] for row in observations}
    require(len(ids) == len(observations), "Observation IDs must be unique")
    power_law = instance["model"] == "initial_rate_power_law"
    batches = {"train": set(), "holdout": set()}
    conditions = {"train": set(), "holdout": set()}
    condition_features = {}
    train_design = []
    for row in observations:
        if power_law:
            require(row["temperature_K"] == instance["temperature_K"],
                    "Initial-rate power law requires a fixed temperature")
            require(row["concentrations"].keys() == set(instance["reactants"]),
                    "Concentrations must cover the declared reactants exactly")
            require(row["conversion_fraction"] <= instance["max_conversion_fraction"],
                    "Observation exceeds the initial-rate conversion limit")
        features = tuple(_features(instance, row))
        require(all(math.isfinite(value) for value in features),
                "Kinetic predictors must be float-representable")
        partition = row["partition"]
        condition_id = row["condition_id"]
        require(condition_features.setdefault(condition_id, features) == features,
                "One condition ID cannot represent different predictor settings")
        batches[partition].add(row["batch_id"])
        conditions[partition].add(features)
        if partition == "train":
            train_design.append(features)

    require(batches["train"].isdisjoint(batches["holdout"]),
            "Holdout batches must be disjoint from training batches")
    require(not batches["holdout"] or "max_holdout_log_rmse" in instance["acceptance"],
            "An evaluated holdout requires a declared holdout log RMSE limit")
    parameter_count = 1 + (len(instance["reactants"]) if power_law else 1)
    require(len(conditions["train"]) >= parameter_count,
            "Need at least as many independent training conditions as fitted parameters")
    rank = _rank(train_design)
    require(rank == parameter_count, "Training design is rank deficient")
    warnings = set()
    if len(conditions["train"]) == parameter_count:
        warnings.add("no_condition_residual_dof")
    if len(batches["train"]) == 1:
        warnings.add("single_training_batch")
    if not batches["holdout"]:
        scope = "training_only"
        warnings.add("no_holdout")
    elif conditions["holdout"] <= conditions["train"]:
        scope = "independent_batch_repeatability"
    elif conditions["holdout"].isdisjoint(conditions["train"]):
        scope = "independent_batch_new_conditions"
    else:
        scope = "independent_batch_mixed_conditions"
    return rank, scope, warnings


def validate_input(instance: dict) -> None:
    """Validate quality gates, batch and condition separation, and design rank."""
    _validate_design(instance)


def validate_result(instance: dict, input_instance: dict) -> None:
    """Check candidate parameters against observations and declared error limits."""
    rank, scope, warnings = _validate_design(input_instance)
    validate_payload("kinetics.result.schema.json", instance)
    for key in ("model", "source"):
        require(instance[key] == input_instance[key], f"Result {key} must match input")
    require(instance["design_rank"] == rank, "Reported design rank must match the training design")

    require(instance["validation_scope"] == scope, "Validation scope disagrees with the design")
    require(set(instance["warnings"]) == warnings, "Warnings disagree with the design")

    power_law = instance["model"] == "initial_rate_power_law"
    if power_law:
        require(instance["rate_at_reference_unit"] == input_instance["response_unit"],
                "Reference rate and observed initial rates must use the same basis")
        reactants = input_instance["reactants"]
        require(instance["orders"].keys() == set(reactants),
                "Reaction orders must cover the declared reactants exactly")
        coefficients = [instance["orders"][key] for key in reactants]
        intercept = math.log(instance["rate_at_reference"])
        parameters = {"rate_at_reference": instance["rate_at_reference"]}
        parameters.update({f"order:{key}": instance["orders"][key] for key in reactants})
    else:
        require(instance["prefactor_unit"] == input_instance["response_unit"],
                "Arrhenius prefactor and observed k must use the same units")
        coefficients = [-instance["activation_energy"] / GAS_CONSTANT_J_PER_MOL_K]
        intercept = math.log(instance["prefactor"])
        parameters = {key: instance[key] for key in ("prefactor", "activation_energy")}

    uncertainty = instance["parameter_uncertainty"]
    if uncertainty["status"] == "reported":
        intervals = uncertainty["intervals"]
        require(intervals.keys() == parameters.keys(), "Intervals must cover all fitted parameters")
        for key, value in parameters.items():
            interval = intervals[key]
            require(interval["lower"] < interval["upper"]
                    and interval["lower"] <= value <= interval["upper"],
                    f"Interval for {key} must have positive width and bracket its estimate")

    residuals = {"train": [], "holdout": []}
    reported = {row["observation_id"]: row["log_residual"] for row in instance["residuals"]}
    observations = input_instance["observations"]
    require(len(reported) == len(instance["residuals"])
            and reported.keys() == {row["observation_id"] for row in observations},
            "Residuals must cover each observation exactly once")
    for row in observations:
        terms = [weight * feature
                 for weight, feature in zip(coefficients, _features(input_instance, row))]
        try:
            error = math.fsum([intercept, *terms, -math.log(row["value"])])
        except (OverflowError, ValueError):
            require(False, "Kinetic prediction exceeded float range")
        require(math.isfinite(error), "Kinetic residual must be finite")
        require(math.isclose(reported[row["observation_id"]], error, abs_tol=1e-10, rel_tol=1e-9),
                f"Residual for {row['observation_id']} disagrees with recomputed prediction")
        residuals[row["partition"]].append(error)

    for partition, errors in residuals.items():
        field = f"{partition}_log_rmse"
        if not errors:
            require(instance[field] is None, f"{field} must be null when the partition is absent")
            continue
        require(instance[field] is not None, f"{field} is required for an evaluated partition")
        rmse = math.hypot(*(error / math.sqrt(len(errors)) for error in errors))
        require(math.isclose(instance[field], rmse, abs_tol=1e-10, rel_tol=1e-9),
                f"Reported {field} disagrees with recomputed predictions")
        require(rmse <= input_instance["acceptance"][f"max_{field}"],
                f"{partition} prediction exceeds the declared log RMSE limit")
