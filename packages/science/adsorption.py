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
    clean = input_instance["clean_slab"]
    gas = {run["structure_id"]: run for run in input_instance["gas_references"]}
    outcomes = {result["structure_id"]: result for result in instance["results"]}
    configurations = input_instance["configurations"]
    require(len(outcomes) == len(instance["results"])
            and outcomes.keys() == {config["structure_id"] for config in configurations},
            "Results must cover each configuration exactly once")
    for config in configurations:
        result = outcomes[config["structure_id"]]
        references = [(gas[key], Fraction(str(coefficient)))
                      for key, coefficient in config["reference_coefficients"].items()]
        reasons = set(_reasons(input_instance, config, references))
        if reasons:
            require(result["status"] == "noncomparable" and set(result["reasons"]) == reasons,
                    f"{config['structure_id']} requires noncomparable outcome: {sorted(reasons)}")
            continue

        require(result["status"] == "comparable",
                f"{config['structure_id']} requires comparable outcome")
        cell_energy = Fraction(str(config["energy_eV"])) - Fraction(str(clean["energy_eV"]))
        gas_energy = sum(coefficient * Fraction(str(run["energy_eV"]))
                         for run, coefficient in references)
        energy = (cell_energy - gas_energy) / config["adsorbed_units"]
        candidate = Fraction(str(result["adsorption_energy"]))
        require(abs(candidate - energy) <= Fraction("0.001"),
                f"{config['structure_id']} adsorption energy disagrees with input energies")
