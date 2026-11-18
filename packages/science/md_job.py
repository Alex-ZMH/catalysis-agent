"""Build an offline LAMMPS job bundle from explicit structure and model inputs."""
from io import BytesIO
import json
from math import isfinite
import re
from zipfile import ZIP_DEFLATED, ZipFile

from .md_handoff import export_structure


_REQUIRED = {"integrator", "steps", "dt_ps", "initial_temperature_K", "seed",
             "thermo_every", "dump_every", "boundary", "force_field"}
_ELEMENT = re.compile(r"[A-Za-z][A-Za-z0-9_+-]{0,31}")
_POTENTIAL = "potential.eam.alloy"


def _number(value, name, *, allow_zero=False):
    if type(value) not in (int, float):
        raise ValueError(f"{name} must be numeric")
    try:
        result = float(value)
    except OverflowError as error:
        raise ValueError(f"{name} is outside the numeric range") from error
    if not isfinite(result) or result < 0 or (result == 0 and not allow_zero):
        raise ValueError(f"{name} must be finite and {'nonnegative' if allow_zero else 'positive'}")
    return result


def _int(value, name, maximum):
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer between 1 and {maximum}")
    return value


def _config(config):
    if (not isinstance(config, dict) or not _REQUIRED <= config.keys()
            or config.keys() - _REQUIRED - {"damping_ps", "structure_options", "restart_every"}):
        raise ValueError("Invalid MD configuration fields")
    integrator = config["integrator"]
    if integrator not in ("nve", "nvt"):
        raise ValueError("integrator must be nve or nvt")
    if ("damping_ps" in config) != (integrator == "nvt"):
        raise ValueError("damping_ps is required for NVT and is only used by NVT")
    boundary = config["boundary"]
    if (not isinstance(boundary, (list, tuple)) or len(boundary) != 3
            or any(value not in ("p", "f", "s", "m") for value in boundary)):
        raise ValueError("boundary must contain three choices from p, f, s, m")
    result = dict(config, boundary=list(boundary))
    for field in ("steps", "thermo_every", "dump_every", "seed"):
        result[field] = _int(config[field], field, 900_000_000 if field == "seed" else 2**31 - 1)
    if "restart_every" in config:
        result["restart_every"] = _int(config["restart_every"], "restart_every", 2**31 - 1)
    result["dt_ps"] = _number(config["dt_ps"], "dt_ps")
    result["initial_temperature_K"] = _number(config["initial_temperature_K"],
                                              "initial_temperature_K", allow_zero=integrator == "nve")
    if integrator == "nvt":
        result["damping_ps"] = _number(config["damping_ps"], "damping_ps")
    return result


def _lj(force_field, type_count, potential):
    if potential is not None or force_field.keys() != {"style", "cutoff_A", "pairs"}:
        raise ValueError("lj/cut requires cutoff_A and explicit pairs, without a potential file")
    cutoff = _number(force_field["cutoff_A"], "force_field.cutoff_A")
    pairs = force_field["pairs"]
    if not isinstance(pairs, list) or len(pairs) != type_count * (type_count + 1) // 2:
        raise ValueError("Provide one LJ coefficient row for every unordered type pair")
    indexed = {}
    required = {"i", "j", "epsilon_eV", "sigma_A"}
    for pair in pairs:
        if (not isinstance(pair, dict) or not required <= pair.keys()
                or pair.keys() - required - {"cutoff_A"}):
            raise ValueError("Invalid LJ coefficient fields")
        i, j = sorted(_int(pair[key], key, type_count) for key in ("i", "j"))
        if (i, j) in indexed:
            raise ValueError("Duplicate LJ type pair")
        row = dict(i=i, j=j, epsilon_eV=_number(pair["epsilon_eV"], "epsilon_eV", allow_zero=True),
                   sigma_A=_number(pair["sigma_A"], "sigma_A"))
        if "cutoff_A" in pair:
            row["cutoff_A"] = _number(pair["cutoff_A"], "pair cutoff_A")
        indexed[i, j] = row
    ordered = [indexed[key] for key in sorted(indexed)]
    commands = [f"pair_style lj/cut {cutoff}"]
    for row in ordered:
        command = f"pair_coeff {row['i']} {row['j']} {row['epsilon_eV']} {row['sigma_A']}"
        if "cutoff_A" in row:
            command += f" {row['cutoff_A']}"
        commands.append(command)
    return dict(style="lj/cut", cutoff_A=cutoff, pairs=ordered), commands


def _eam(force_field, type_count, potential):
    if (force_field.keys() != {"style", "elements"} or not isinstance(potential, bytes)
            or not 0 < len(potential) <= 128 * 1024**2):
        raise ValueError("eam/alloy requires elements and an operator-supplied setfl file up to 128 MiB")
    elements = force_field["elements"]
    if (not isinstance(elements, (list, tuple)) or len(elements) != type_count
            or any(not isinstance(element, str) or not _ELEMENT.fullmatch(element)
                   or element == "NULL" for element in elements)):
        raise ValueError("Supply one EAM element per atom type in type-ID order")
    header = BytesIO(potential)
    try:
        for _ in range(3):
            header.readline(4096)
        declared = header.readline(4096).decode("ascii").split()
        if (not declared or int(declared[0]) != len(declared) - 1
                or len(set(declared[1:])) != len(declared) - 1
                or not set(elements) <= set(declared[1:])):
            raise ValueError
        nrho, drho, nr, dr, cutoff = header.readline(4096).decode("ascii").split()
        if min(int(nr), int(nrho)) <= 0 or not all(
            isfinite(float(value)) and float(value) > 0 for value in (dr, drho, cutoff)
        ) or not header.read(1):
            raise ValueError
    except ValueError as error:
        raise ValueError("Invalid EAM setfl header or element mapping") from error
    return dict(style="eam/alloy", elements=list(elements)), [
        "pair_style eam/alloy",
        f"pair_coeff * * {_POTENTIAL} {' '.join(elements)}",
    ]


def _script(config, pair_commands, structure, *, restarting=False):
    temperature = config["initial_temperature_K"]
    commands = ["log log.lammps"]
    if restarting:
        commands.append("read_restart source.restart")
    else:
        commands.extend(("units metal", "atom_style atomic",
                         f"boundary {' '.join(config['boundary'])}", "read_data structure.data"))
    if not restarting or config["force_field"]["style"] == "eam/alloy":
        commands.extend(pair_commands)
    if config["force_field"]["style"] == "eam/alloy":
        # EAM pair coefficients can set masses from the table. Reapply the
        # resolved structure masses, including explicit operator overrides.
        commands.extend(f"mass {row['type_id']} {row['mass']:.17g}" for row in structure["species"])
    commands.append(f"timestep {config['dt_ps']}")
    single = structure["atom_count"] == 1 and temperature > 0
    if single:
        # A single atom has no thermal DOF after subtracting COM motion.
        commands.extend(("compute md_temperature all temp",
                         "compute_modify md_temperature extra/dof 0"))
    if temperature and not restarting:
        settings = "mom no rot no dist gaussian temp md_temperature" if single else "mom yes rot no dist gaussian"
        commands.append(f"velocity all create {temperature} {config['seed']} {settings}")
    if config["integrator"] == "nvt":
        commands.append(f"fix md_integrator all nvt temp {temperature} {temperature} {config['damping_ps']}")
        if single:
            commands.append("fix_modify md_integrator temp md_temperature")
    else:
        commands.append("fix md_integrator all nve")
    commands.extend([
        f"thermo {config['thermo_every']}",
        "thermo_style custom step time temp pe ke etotal press",
    ])
    if single:
        commands.append("thermo_modify temp md_temperature")
    commands.extend([
        f"dump md_trajectory all custom {config['dump_every']} trajectory.lammpstrj id type x y z ix iy iz vx vy vz",
        "dump_modify md_trajectory sort id units yes format float %.17g",
    ])
    if interval := config.get("restart_every"):
        interval = min(interval, config["steps"])
        commands.extend((
            "thermo_modify flush yes",
            f'run {config["steps"]} every {interval} "write_restart checkpoint.tmp" '
            '"shell mv checkpoint.tmp checkpoint.$(step:%.0f)"',
            "write_data final.data",
            "write_restart checkpoint.tmp",
            "shell mv checkpoint.tmp final.restart",
        ))
    else:
        commands.extend((f"run {config['steps']}", "write_data final.data",
                         "write_restart final.restart"))
    return ("\n".join(commands) + "\n").encode("ascii")


def build_job(filename, source_bytes, config, *, potential=None, provenance=None, restarting=False):
    """Return a ZIP with fixed commands, the supplied source, and resolved inputs."""
    config = _config(config)
    if provenance is not None and not isinstance(provenance, dict):
        raise ValueError("provenance must be an object")
    if isinstance(filename, str) and (":" in filename or "\x7f" in filename):
        raise ValueError("Invalid ZIP source filename")
    structure_data, structure = export_structure(filename, source_bytes, config.get("structure_options", {}))
    nonperiodic = [axis for axis, mode in enumerate(config["boundary"]) if mode != "p"]
    if nonperiodic:
        atoms = structure_data.split(b"\nAtoms # atomic\n\n", 1)[1]
        if any(int(row.split()[5 + axis]) for row in atoms.splitlines() for axis in nonperiodic):
            raise ValueError("Source atoms outside a nonperiodic boundary cannot preserve their images")
    force_field = config["force_field"]
    style = force_field.get("style") if isinstance(force_field, dict) else None
    type_count = structure["atom_type_count"]
    if style == "lj/cut":
        config["force_field"], pair_commands = _lj(force_field, type_count, potential)
    elif style == "eam/alloy":
        config["force_field"], pair_commands = _eam(force_field, type_count, potential)
    else:
        raise ValueError("Select explicit lj/cut or eam/alloy force_field")

    files = dict(input="in.md", structure="structure.data", source=f"source/{filename}")
    if potential is not None:
        files["potential"] = _POTENTIAL
    metadata = dict(version=1, config=config, structure=structure, provenance=provenance, files=files)
    try:
        encoded = json.dumps(metadata, allow_nan=False, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError, OverflowError, RecursionError) as error:
        raise ValueError("MD metadata must be JSON serializable") from error
    buffer = BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(files["input"], _script(config, pair_commands, structure, restarting=restarting))
        archive.writestr(files["structure"], structure_data)
        archive.writestr("md-config.json", encoded)
        archive.writestr(files["source"], source_bytes)
        if potential is not None:
            archive.writestr(_POTENTIAL, potential)
    return buffer.getvalue()
