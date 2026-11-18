"""Semantic validation of v1 periodic DFT adsorption contracts."""

from collections import Counter
from fractions import Fraction

from .validation import require, validate_payload


def validate_input(instance: dict) -> None:
    """Validate declared structures and lineage, including reportable failed runs."""
    validate_payload("adsorption.input.schema.json", instance)
    bulk = instance["bulk"]
    clean = instance["clean_slab"]
    configurations = instance["configurations"]
    runs = [bulk, clean, *configurations, *instance["gas_references"]]
    require(len({run["structure_id"] for run in runs}) == len(runs),
            "Structure IDs must uniquely identify all runs")
    require(clean["bulk_structure_id"] == bulk["structure_id"],
            "Clean slab must link to the declared bulk structure")
    require(any(clean["miller_indices"]), "Miller indices cannot all be zero")
    for run in runs:
        method = run["method"]
        elements = run["composition"].keys()
        require(method["pseudopotential_ids"].keys() == elements,
                "Pseudopotential IDs must cover exactly the run's elements")
        require(method["hubbard_U_eV"].keys() <= elements,
                "Hubbard U entries must belong to the run's elements")
        require(not (method["magnetism"]["spin_orbit"]
                     and method["magnetism"]["mode"] != "noncollinear"),
                "v1 requires noncollinear mode for spin-orbit calculations")
    reference_ids = {run["structure_id"] for run in instance["gas_references"]}
    for config in configurations:
        require(config["clean_structure_id"] == clean["structure_id"],
                "Adsorbed configuration must link to the declared clean slab")
        require(config["reference_coefficients"].keys() <= reference_ids,
                "Reference coefficients must name declared gas structures")


def _converged(run):
    evidence = run["convergence"]
    return (evidence["scf_residual_eV"] <= evidence["scf_limit_eV"]
            and evidence["max_free_force_eV_per_angstrom"]
            <= evidence["force_limit_eV_per_angstrom"])


def _compatible_electronic_method(anchor, other):
    # Bulk and gas can have different spin states, occupations and sampling.
    for key in ("functional", "cutoff_eV", "dispersion"):
        if anchor[key] != other[key]:
            return False
    if anchor["magnetism"]["spin_orbit"] != other["magnetism"]["spin_orbit"]:
        return False
    for element in anchor["pseudopotential_ids"].keys() & other["pseudopotential_ids"].keys():
        if anchor["pseudopotential_ids"][element] != other["pseudopotential_ids"][element]:
            return False
        if anchor["hubbard_U_eV"].get(element, 0) != other["hubbard_U_eV"].get(element, 0):
            return False
    return True


def _reasons(instance, config, references):
    bulk = instance["bulk"]
    clean = instance["clean_slab"]
    if not all(_converged(run) for run in (bulk, clean, config, *(run for run, _ in references))):
        yield "unconverged"
    check = clean["finite_size_check"]
    if max(check["thickness_effect_eV"], check["vacuum_effect_eV"]) > check["limit_eV"]:
        yield "finite_size"
    if any(config[key] != clean[key] for key in ("fixed_layers_id", "vacuum_angstrom", "k_grid", "k_grid_centering")):
        yield "slab_protocol"

    clean_method = clean["method"]
    config_method = config["method"]
    slab_keys = ("occupation_scheme", "smearing_eV", "magnetism")
    methods = [bulk["method"], clean_method, config_method, *(run["method"] for run, _ in references)]
    if (any(config_method[key] != clean_method[key] for key in slab_keys)
            or any(not _compatible_electronic_method(first, second)
                   for index, first in enumerate(methods) for second in methods[index + 1:])):
        yield "electronic_method"
    if any(run["k_grid"] != [1, 1, 1] or run["k_grid_centering"] != "gamma"
           or run["isolation_check"]["effect_eV"] > run["isolation_check"]["limit_eV"]
           for run, _ in references):
        yield "reference_protocol"

    expected = {element: count * config["adsorbed_units"]
                for element, count in instance["adsorbate_formula"].items()}
    difference = Counter(config["composition"])
    difference.subtract(clean["composition"])
    supplied = Counter()
    for run, coefficient in references:
        for element, count in run["composition"].items():
            supplied[element] += coefficient * count
    if difference != Counter(expected) or supplied != Counter(expected):
        yield "reference_stoichiometry"
    charge = Fraction(str(config_method["charge_e"])) - Fraction(str(clean_method["charge_e"]))
    reference_charge = sum(coefficient * Fraction(str(run["method"]["charge_e"]))
                           for run, coefficient in references)
    # This v1 protocol has no charged-cell or charged-fragment corrections.
    if charge != reference_charge or any(method["charge_e"] for method in methods):
        yield "charge_balance"


def validate_result(instance: dict, input_instance: dict) -> None:
    """Validate all outcomes and recompute comparable adsorption energies."""
    validate_input(input_instance)
    validate_payload("adsorption.result.schema.json", instance)
    outcomes = {result["structure_id"]: result for result in instance["results"]}
    reported = instance.get("observed_adsorption")
    observed = [] if reported is not None else None
    expected = _outcomes(input_instance, observed)
    require(len(outcomes) == len(instance["results"])
            and outcomes.keys() == {item["structure_id"] for item in expected},
            "Results must cover each configuration exactly once")
    for item in expected:
        structure_id = item["structure_id"]
        result = outcomes[structure_id]
        reasons = item.get("reasons")
        if reasons:
            require(result["status"] == "noncomparable" and set(result["reasons"]) == set(reasons),
                    f"{structure_id} requires noncomparable outcome: {sorted(reasons)}")
            continue

        require(result["status"] == "comparable",
                f"{structure_id} requires comparable outcome")
        candidate = Fraction(str(result["adsorption_energy"]))
        require(abs(candidate - item["adsorption_energy"]) <= Fraction("0.001"),
                f"{structure_id} adsorption energy disagrees with input energies")

    if observed is not None:
        by_id = {row["structure_id"]: row for row in reported}
        require(len(by_id) == len(reported) and by_id.keys() == outcomes.keys(),
                "Observed adsorption must cover each configuration exactly once")
        for item, formal in zip(observed, expected, strict=True):
            structure_id = item["structure_id"]
            row = by_id[structure_id]
            require(abs(Fraction(str(row["adsorption_energy_eV"])) - item["adsorption_energy_eV"])
                    <= Fraction("0.001"), f"{structure_id} observed adsorption energy disagrees with input energies")
            require(row["contract_status"] == formal["status"] and set(row["reasons"]) == set(item["reasons"]),
                    f"{structure_id} observed adsorption metadata disagrees with the formal outcome")
            status = "review" if row["reasons"] or row["annotations"] else "comparable"
            require(row["status"] == status, f"{structure_id} observed status disagrees with its diagnostics")


def _outcomes(instance, observed=None):
    clean = instance["clean_slab"]
    gas = {run["structure_id"]: run for run in instance["gas_references"]}
    clean_energy = Fraction(str(clean["energy_eV"]))
    outcomes = []
    for config in instance["configurations"]:
        references = [(gas[key], Fraction(str(coefficient)))
                      for key, coefficient in config["reference_coefficients"].items()]
        outcome = {"structure_id": config["structure_id"]}
        reasons = list(_reasons(instance, config, references))
        if not reasons or observed is not None:
            cell_energy = Fraction(str(config["energy_eV"])) - clean_energy
            gas_energy = sum(coefficient * Fraction(str(run["energy_eV"]))
                             for run, coefficient in references)
            energy = (cell_energy - gas_energy) / config["adsorbed_units"]
        if observed is not None:
            observed.append(dict(outcome, adsorption_energy_eV=energy, reasons=reasons))
        if reasons:
            outcomes.append(dict(outcome, status="noncomparable", reasons=reasons))
        else:
            outcomes.append(dict(outcome, status="comparable", normalization="per_adsorbate",
                                 unit="eV", adsorption_energy=energy))
    return outcomes


def derive_result(instance: dict, *, observed=None) -> dict:
    """Validate input and derive v1 results, optionally collecting unfiltered energies."""
    validate_input(instance)
    outcomes = _outcomes(instance, observed)
    for outcome in outcomes:
        if outcome["status"] == "comparable":
            outcome["adsorption_energy"] = float(outcome["adsorption_energy"])
    if observed is not None:
        for row in observed:
            row["adsorption_energy_eV"] = float(row["adsorption_energy_eV"])
    return {"results": outcomes}
