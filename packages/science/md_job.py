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
_TRANSPORT_CHANNELS = {"heat_global", "heat_profile", "mass_flux_profile",
                       "momentum_flux_profile"}
_TRANSPORT_FIELDS = {"temperature", "concentration", "velocity"}
_TRANSPORT_AXES = ("x", "y", "z")
_TRANSPORT_COMPONENTS = ("xx", "yy", "zz", "xy", "xz", "yz")
_TRANSPORT_COMPONENT_INDEX = dict(zip(_TRANSPORT_COMPONENTS, range(1, 7), strict=True))
_TRANSPORT_PREFIX = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}")
_METAL_PRESSURE_VOLUME_PER_EV = 1.602176634e6


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


def _finite(value, name):
    if type(value) not in (int, float):
        raise ValueError(f"{name} must be numeric")
    try:
        result = float(value)
    except OverflowError as error:
        raise ValueError(f"{name} is outside the numeric range") from error
    if not isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _transport_components(axis, requested):
    tangential = {
        "x": ("y", "z"),
        "y": ("x", "z"),
        "z": ("x", "y"),
    }[axis]
    resolved = []
    for component in requested:
        if component == "normal":
            value = axis + axis
        elif component == "tangential_x":
            value = "".join(sorted((axis, tangential[0])))
        elif component == "tangential_y":
            value = "".join(sorted((axis, tangential[1])))
        else:
            value = component
        if value not in _TRANSPORT_COMPONENTS:
            raise ValueError("momentum.components must use normal, tangential_x, "
                             "tangential_y, or a valid tensor component")
        if axis not in value:
            raise ValueError("momentum components must carry the selected slab normal")
        if value in resolved:
            raise ValueError("momentum.components must be unique")
        resolved.append(value)
    return resolved


def _transport_config(raw, steps, structure=None):
    """Normalize the opt-in LAMMPS transport sampling contract."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("transport_sampling must be an object")
    allowed = {
        "enabled", "sample_every", "average", "average_samples", "axis", "bins",
        "start", "end", "species", "fields", "channels", "mass_flux_reference",
        "momentum", "output_prefix",
    }
    # Bundled jobs persist the normalized sampling contract. The derived
    # output names and concentration species are recomputed below.
    derived = {"outputs", "concentration_species"}
    if raw.keys() - allowed - derived:
        raise ValueError("Invalid transport_sampling fields")
    enabled = raw.get("enabled")
    if type(enabled) is not bool:
        raise ValueError("transport_sampling.enabled must be boolean")
    if not enabled:
        if raw.keys() != {"enabled"}:
            raise ValueError("Disabled transport_sampling accepts only enabled=false")
        return {"enabled": False}

    required = {"sample_every", "average", "axis", "bins", "channels"}
    if not required <= raw.keys():
        raise ValueError("Enabled transport_sampling requires sample_every, average, axis, bins, and channels")
    sample_every = _int(raw["sample_every"], "transport_sampling.sample_every", 2**31 - 1)
    average = raw["average"]
    if average not in ("one", "running", "window"):
        raise ValueError("transport_sampling.average must be one, running, or window")
    average_samples = _int(raw.get("average_samples", 1),
                           "transport_sampling.average_samples", 2**31 - 1)
    if sample_every * average_samples > 2**31 - 1 or sample_every * average_samples > steps:
        raise ValueError("transport sampling average interval must fit inside the MD run")
    axis = raw["axis"]
    if axis not in _TRANSPORT_AXES:
        raise ValueError("transport_sampling.axis must be x, y, or z")
    bins = _int(raw["bins"], "transport_sampling.bins", 1_000_000)

    channels = raw["channels"]
    if (not isinstance(channels, list) or not channels or len(set(channels)) != len(channels)
            or any(channel not in _TRANSPORT_CHANNELS for channel in channels)):
        raise ValueError("transport_sampling.channels must be a unique nonempty list of supported channels")
    species = raw.get("species", [])
    if (not isinstance(species, list) or len(set(species)) != len(species)
            or any(not isinstance(label, str) or not _ELEMENT.fullmatch(label) for label in species)):
        raise ValueError("transport_sampling.species must contain unique safe species labels")
    if structure is not None:
        labels = {row["symbol"] for row in structure["species"]}
        if any(label not in labels for label in species):
            raise ValueError("transport_sampling.species must match structure species labels")

    fields = raw.get("fields", [])
    if (not isinstance(fields, list) or len(set(fields)) != len(fields)
            or any(field not in _TRANSPORT_FIELDS for field in fields)):
        raise ValueError("transport_sampling.fields must contain temperature, concentration, and/or velocity")
    profile_channels = _TRANSPORT_CHANNELS - {"heat_global"}
    if any(field in fields for field in _TRANSPORT_FIELDS) and not profile_channels.intersection(channels):
        raise ValueError("transport_sampling.fields require a profile channel")
    if ("mass_flux_profile" in channels
            and (not species or "mass_flux_reference" not in raw)):
        raise ValueError("mass_flux_profile requires species and an explicit mass_flux_reference")
    mass_flux_reference = raw.get("mass_flux_reference")
    if mass_flux_reference is not None and mass_flux_reference not in ("lab", "barycentric"):
        raise ValueError("mass_flux_reference must be lab or barycentric")
    concentration_species = species if "concentration" in fields else []

    momentum = raw.get("momentum")
    normalized_momentum = None
    if "momentum_flux_profile" in channels:
        if (not isinstance(momentum, dict)
                or momentum.keys() - {"convention", "components", "stress_source", "requested_components"}):
            raise ValueError("momentum_flux_profile requires explicit momentum convention, components, and stress_source")
        if not {"convention", "components", "stress_source"} <= momentum.keys():
            raise ValueError("momentum must contain convention, components, and stress_source")
        convention = momentum["convention"]
        stress_source = momentum["stress_source"]
        components = momentum["components"]
        if convention not in ("momentum_flux", "cauchy_stress"):
            raise ValueError("momentum.convention must be momentum_flux or cauchy_stress")
        if stress_source not in ("virial", "kinetic_virial"):
            raise ValueError("momentum.stress_source must be virial or kinetic_virial")
        if (not isinstance(components, list) or not components
                or len(set(components)) != len(components)
                or any(not isinstance(component, str) for component in components)):
            raise ValueError("momentum.components must be a unique nonempty list")
        resolved = _transport_components(axis, components)
        normalized_momentum = dict(convention=convention, components=resolved,
                                   requested_components=list(components),
                                   stress_source=stress_source)
    elif momentum is not None:
        raise ValueError("momentum is only valid with momentum_flux_profile")

    start = raw.get("start")
    end = raw.get("end")
    if (start is None) != (end is None):
        raise ValueError("transport_sampling.start and end must be supplied together")
    if structure is not None:
        length = structure["cell"]["lengths_A"][_TRANSPORT_AXES.index(axis)]
        start = 0.0 if start is None else _finite(start, "transport_sampling.start")
        end = length if end is None else _finite(end, "transport_sampling.end")
        if not 0 <= start < end <= length:
            raise ValueError("transport_sampling slab bounds must lie inside the simulation box")
        if any(abs(value) > 1e-12 for value in structure["cell"]["tilt_A"].values()):
            raise ValueError("Transport sampling currently requires an orthogonal simulation box")
    else:
        start = None if start is None else _finite(start, "transport_sampling.start")
        end = None if end is None else _finite(end, "transport_sampling.end")

    output_prefix = raw.get("output_prefix", "transport")
    if not isinstance(output_prefix, str) or not _TRANSPORT_PREFIX.fullmatch(output_prefix):
        raise ValueError("transport_sampling.output_prefix must be a safe file basename")
    outputs = {
        "profile": f"{output_prefix}_profile.dat" if profile_channels.intersection(channels) else None,
        "global_flux": f"{output_prefix}_global.dat" if "heat_global" in channels else None,
        "velocity": f"{output_prefix}_velocity.dat" if "velocity" in fields else None,
        "metadata": f"{output_prefix}_metadata.json",
    }
    result = dict(
        enabled=True, sample_every=sample_every, average=average,
        average_samples=average_samples, axis=axis, bins=bins, start=start, end=end,
        species=list(species), fields=list(fields), channels=list(channels),
        output_prefix=output_prefix, outputs=outputs,
    )
    if mass_flux_reference is not None:
        result["mass_flux_reference"] = mass_flux_reference
    if normalized_momentum is not None:
        result["momentum"] = normalized_momentum
    result["concentration_species"] = list(concentration_species)
    return result


def _config(config):
    if (not isinstance(config, dict) or not _REQUIRED <= config.keys()
            or config.keys() - _REQUIRED
            - {"damping_ps", "structure_options", "restart_every", "transport_sampling"}):
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
    if "transport_sampling" in config and not isinstance(config["transport_sampling"], dict):
        raise ValueError("transport_sampling must be an object")
    return result


def _transport_columns(sampling, structure):
    type_ids = {row["symbol"]: row["type_id"] for row in structure["species"]}
    profile = {"time": "Timestep", "position": "Coord1", "count": "Ncount"}
    if "temperature" in sampling["fields"]:
        profile["temperature"] = "temp"
    if "concentration" in sampling["fields"]:
        profile["concentration"] = {
            label: f"v_transport_concentration_{type_ids[label]}"
            for label in sampling["concentration_species"]
        }
    if "mass_flux_profile" in sampling["channels"]:
        profile["mass_flux"] = {
            label: f"v_transport_mass_flux_{type_ids[label]}"
            for label in sampling["species"]
        }
    if "heat_profile" in sampling["channels"]:
        profile["heat_flux"] = "v_transport_heat_profile"
    if "momentum_flux_profile" in sampling["channels"]:
        profile["momentum_flux"] = {
            component: f"v_transport_momentum_{component}"
            for component in sampling["momentum"]["components"]
        }
    velocity = None
    if "velocity" in sampling["fields"]:
        velocity = {
            "time": "Timestep", "position": "Coord1", "count": "Ncount",
            "x": "vx", "y": "vy", "z": "vz",
        }
    global_columns = None
    if "heat_global" in sampling["channels"]:
        global_columns = {
            "time": "TimeStep",
            "extensive_total": [f"c_transport_heat[{index}]" for index in range(1, 4)],
            "extensive_convective": [f"c_transport_heat[{index}]" for index in range(4, 7)],
            "normalized_total": [f"v_transport_heat_total_{axis}" for axis in _TRANSPORT_AXES],
            "normalized_convective": [f"v_transport_heat_convective_{axis}"
                                      for axis in _TRANSPORT_AXES],
            "normalized_conductive": [f"v_transport_heat_conductive_{axis}"
                                      for axis in _TRANSPORT_AXES],
        }
    return profile, velocity, global_columns


def transport_metadata(config, structure):
    """Return the sidecar contract for generated native transport outputs."""
    sampling = config.get("transport_sampling")
    if not sampling or not sampling.get("enabled"):
        return None
    profile_columns, velocity_columns, global_columns = _transport_columns(sampling, structure)
    axis = sampling["axis"]
    lengths = structure["cell"]["lengths_A"]
    axis_length = lengths[_TRANSPORT_AXES.index(axis)]
    volume = lengths[0] * lengths[1] * lengths[2]
    span = sampling["end"] - sampling["start"]
    bin_volume = volume * span / axis_length / sampling["bins"]
    profile_units = {
        "position": {"lammps": "angstrom", "si": "m"},
        "time": {"lammps": "step", "si": "s"},
        "temperature": {"lammps": "K", "si": "K"},
        "velocity": {"lammps": "angstrom/ps", "si": "m/s"},
        "concentration": {"lammps": "g/(mol*angstrom^3)", "si": "kg/m^3", "basis": "mass"},
        "heat_flux": {"lammps": "eV/(angstrom^2*ps)", "si": "W/m^2"},
        "mass_flux": {"lammps": "g/(mol*angstrom^2*ps)", "si": "kg/(m^2*s)"},
        "momentum_flux": {"lammps": "bar", "si": "Pa"},
    }
    limits = [
        "The profile heat column is a per-atom decomposition binned by position; "
        "it is an approximate diagnostic, not an exact local heat-flux operator.",
        "The global heat stream is compute heat/flux divided once by the full simulation-box volume; "
        "do not divide its normalized columns again.",
        "A vacuum or non-periodic slab axis needs an operator-reviewed active cross-section and volume; "
        "the generated box-volume normalization does not establish a surface heat flux.",
        "The selected stress/atom convention and virial assignment are retained verbatim; "
        "no sign flip is hidden in postprocessing.",
    ]
    if (config["boundary"][_TRANSPORT_AXES.index(axis)] != "p"
            or sampling["start"] != 0.0 or sampling["end"] != axis_length):
        geometry_limit = "vacuum_or_nonperiodic_axis_requires_area_and_active_volume_review"
    else:
        geometry_limit = None
    return {
        "schema_version": 1,
        "engine": "lammps",
        "lammps_units": "metal",
        "axis": axis,
        "bins": sampling["bins"],
        "slab": {
            "start_A": sampling["start"], "end_A": sampling["end"],
            "width_A": span / sampling["bins"], "bin_volume_A3": bin_volume,
            "box_volume_A3": volume,
            "volume_basis": "box_volume * active_span / box_axis_length / bins",
        },
        "sampling": {
            "sample_every": sampling["sample_every"], "average": sampling["average"],
            "average_samples": sampling["average_samples"],
        },
        "channels": list(sampling["channels"]),
        "fields": list(sampling["fields"]),
        "species": list(sampling["species"]),
        "units": profile_units,
        "normalization": {
            "global_heat": "c_transport_heat[1:3] is extensive eV*angstrom/ps; "
                            "v_transport_heat_total_* divides once by box volume",
            "profile": "per-atom sums are divided once by the fixed active bin volume",
            "velocity": "fix ave/chunk norm sample returns the bin-averaged Cartesian velocity",
            "concentration": "rho_s = sum_i(m_i)/V_bin, mass basis matching mass_flux",
            "mass_flux": "J_s = sum_i(m_i*v_i)/V_bin, or sum_i(m_i*(v_i-u_bary))/V_bin",
            "momentum_flux": "stress/atom is negative pressure; selected convention controls the explicit sign",
            "stress_atom": "bar*angstrom^3; divide by V_bin for bar momentum/stress",
        },
        "energy_convention": {
            "per_atom": "ke/atom + pe/atom",
            "stress_for_heat": "compute stress/atom NULL virial",
            "stress_atom_units": "bar*angstrom^3",
            "stress_to_energy": "multiply stress/atom by 1/1602176.634 to obtain eV",
            "global_compute": "compute heat/flux",
            "convective_components": "compute heat/flux vector entries 4:6",
        },
        "mass_flux_reference": sampling.get("mass_flux_reference"),
        "momentum": sampling.get("momentum"),
        "geometry_limit": geometry_limit,
        "geometry_limits": limits,
        "columns": {
            "profile": profile_columns, "velocity": velocity_columns,
            "global_flux": global_columns,
        },
        "files": dict(sampling["outputs"]),
        "analysis": {
            "md_transport": {
                "profile_requires_explicit_mapping": True,
                "global_heat_is_separate_from_profile": True,
                "preprocessing": "Pair field and flux rows by explicit Timestep and Coord1 mapping; "
                                 "do not substitute global heat for a local profile.",
            }
        },
    }


def _transport_script(config, structure):
    sampling = config.get("transport_sampling")
    if not sampling or not sampling.get("enabled"):
        return []
    axis = sampling["axis"]
    velocity = {"x": "vx", "y": "vy", "z": "vz"}[axis]
    velocity_components = ("vx", "vy", "vz")
    stress_indexes = {"x": (1, 4, 5), "y": (4, 2, 6), "z": (5, 6, 3)}[axis]
    span = sampling["end"] - sampling["start"]
    width = span / sampling["bins"]
    axis_length_name = {"x": "lx", "y": "ly", "z": "lz"}[axis]
    start = format(sampling["start"], ".17g")
    end = format(sampling["end"], ".17g")
    delta = format(width, ".17g")
    bin_volume = "v_transport_bin_volume"
    lines = [
        f"variable transport_box_length equal {axis_length_name}",
        f"variable transport_bin_volume equal vol*({format(span, '.17g')}/v_transport_box_length)/{sampling['bins']}",
        f"compute transport_chunks all chunk/atom bin/1d {axis} {start} {delta} units box "
        f"bound {axis} {start} {end} nchunk once ids every discard yes",
    ]
    if "heat_global" in sampling["channels"] or "heat_profile" in sampling["channels"]:
        lines.extend((
            "compute transport_ke all ke/atom",
            "compute transport_pe all pe/atom",
            "compute transport_heat_stress all stress/atom NULL virial",
        ))
    if "heat_global" in sampling["channels"]:
        lines.append("compute transport_heat all heat/flux transport_ke transport_pe transport_heat_stress")
        for index, component in enumerate(_TRANSPORT_AXES):
            lines.extend((
                f"variable transport_heat_total_{component} equal c_transport_heat[{index + 1}]/vol",
                f"variable transport_heat_convective_{component} equal c_transport_heat[{index + 4}]/vol",
                f"variable transport_heat_conductive_{component} equal "
                f"(c_transport_heat[{index + 1}]-c_transport_heat[{index + 4}])/vol",
            ))
    if "heat_profile" in sampling["channels"]:
        sx, sy, sz = stress_indexes
        lines.append(f"variable transport_stress_to_energy equal 1.0/{_METAL_PRESSURE_VOLUME_PER_EV:.17g}")
        lines.append(
            "variable transport_heat_profile atom "
            f"\"((c_transport_ke+c_transport_pe)*{velocity}-"
            f"(c_transport_heat_stress[{sx}]*v_transport_stress_to_energy*{velocity_components[0]}"
            f"+c_transport_heat_stress[{sy}]*v_transport_stress_to_energy*{velocity_components[1]}"
            f"+c_transport_heat_stress[{sz}]*v_transport_stress_to_energy*{velocity_components[2]}))/{bin_volume}\""
        )
    type_ids = {row["symbol"]: row["type_id"] for row in structure["species"]}
    if "mass_flux_profile" in sampling["channels"]:
        if sampling["mass_flux_reference"] == "barycentric":
            lines.append(f"variable transport_barycentric_velocity equal vcm(all,{axis})")
            reference = "v_transport_barycentric_velocity"
        else:
            reference = "0.0"
        for label in sampling["species"]:
            type_id = type_ids[label]
            lines.append(
                f"variable transport_mass_flux_{type_id} atom "
                f"\"(type=={type_id})*mass*({velocity}-{reference})/{bin_volume}\""
            )
    if "concentration" in sampling["fields"]:
        for label in sampling["concentration_species"]:
            type_id = type_ids[label]
            lines.append(
                f"variable transport_concentration_{type_id} atom "
                f"\"(type=={type_id})*mass/{bin_volume}\""
            )
    if "momentum_flux_profile" in sampling["channels"]:
        if sampling["momentum"]["stress_source"] == "virial":
            lines.append("compute transport_momentum_stress all stress/atom NULL virial")
        else:
            lines.append("compute transport_momentum_stress all stress/atom NULL")
        sign = "-" if sampling["momentum"]["convention"] == "momentum_flux" else ""
        for component in sampling["momentum"]["components"]:
            index = _TRANSPORT_COMPONENT_INDEX[component]
            lines.append(
                f"variable transport_momentum_{component} atom "
                f"\"({sign}c_transport_momentum_stress[{index}])/{bin_volume}\""
            )

    profile_values = []
    if "temperature" in sampling["fields"]:
        profile_values.append("temp")
    profile_values.extend(
        f"v_transport_concentration_{type_ids[label]}" for label in sampling["concentration_species"]
    )
    if "mass_flux_profile" in sampling["channels"]:
        profile_values.extend(f"v_transport_mass_flux_{type_ids[label]}" for label in sampling["species"])
    if "heat_profile" in sampling["channels"]:
        profile_values.append("v_transport_heat_profile")
    if "momentum_flux_profile" in sampling["channels"]:
        profile_values.extend(f"v_transport_momentum_{component}"
                              for component in sampling["momentum"]["components"])

    average_clause = f"ave {sampling['average']}"
    if sampling["average"] == "window":
        average_clause += f" {sampling['average_samples']}"
    frequency = sampling["sample_every"] * sampling["average_samples"]
    if profile_values:
        lines.append(
            f"fix transport_profile all ave/chunk {sampling['sample_every']} "
            f"{sampling['average_samples']} {frequency} transport_chunks "
            f"{' '.join(profile_values)} norm none {average_clause} "
            f"file {sampling['outputs']['profile']} format %24.17g"
        )
    if "velocity" in sampling["fields"]:
        lines.append(
            f"fix transport_velocity all ave/chunk {sampling['sample_every']} "
            f"{sampling['average_samples']} {frequency} transport_chunks vx vy vz "
            f"norm sample {average_clause} file {sampling['outputs']['velocity']} format %24.17g"
        )
    if "heat_global" in sampling["channels"]:
        global_values = [
            *(f"c_transport_heat[{index}]" for index in range(1, 7)),
            *(f"v_transport_heat_total_{component}" for component in _TRANSPORT_AXES),
            *(f"v_transport_heat_convective_{component}" for component in _TRANSPORT_AXES),
            *(f"v_transport_heat_conductive_{component}" for component in _TRANSPORT_AXES),
        ]
        lines.append(
            f"fix transport_global all ave/time {sampling['sample_every']} "
            f"{sampling['average_samples']} {frequency} {' '.join(global_values)} "
            f"{average_clause} file {sampling['outputs']['global_flux']} format %24.17g"
        )
    return lines


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
        ("dump_modify md_trajectory sort id units yes"
         + (" first yes" if restarting else "") + " format float %.17g"),
    ])
    commands.extend(_transport_script(config, structure))
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
    if "transport_sampling" in config:
        config["transport_sampling"] = _transport_config(config["transport_sampling"], config["steps"], structure)
        if config["transport_sampling"].get("enabled"):
            # export_structure writes an explicit zero-tilt line, which makes
            # LAMMPS treat even an orthogonal box as restricted-triclinic.
            # Transport chunking is restricted to orthogonal cells, so omit
            # that redundant line and keep Coord1 in physical box units.
            tilt_line = b"0 0 0 xy xz yz\n"
            if tilt_line not in structure_data:
                raise ValueError("Orthogonal transport structure is missing its zero-tilt data line")
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
