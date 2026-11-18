"""Bounded, pure analysis of native LAMMPS thermo and trajectory artifacts."""

import io
import json
import math
from statistics import linear_regression

from .lammps import _Dump, _LIMITS, _bounded, _integer, _number

_STYLES = {
    "metal": {"length": "angstrom", "time": "ps", "pressure": "bar", "energy": "eV", "temperature": "K"},
    "real": {"length": "angstrom", "time": "fs", "pressure": "atm", "energy": "kcal/mol", "temperature": "K"},
}
_THERMO_QUANTITIES = {
    **dict.fromkeys(("time", "dt"), "time"),
    **dict.fromkeys(("temp",), "temperature"),
    **dict.fromkeys(("press", "pxx", "pyy", "pzz", "pxy", "pxz", "pyz"), "pressure"),
    **dict.fromkeys(("poteng", "kineng", "toteng", "enthalpy", "e_pair", "e_mol",
                     "e_vdwl", "e_coul", "e_bond", "e_angle", "e_dihed", "e_impro",
                     "e_long", "e_tail"), "energy"),
    **dict.fromkeys(("lx", "ly", "lz", "xlo", "xhi", "ylo", "yhi", "zlo", "zhi",
                     "xy", "xz", "yz", "cella", "cellb", "cellc"), "length"),
}
_PICOSECONDS = {"ps": 1.0, "fs": 0.001}
_AXES = ("xyz", "xy", "xz", "yz", "x", "y", "z")


def _unit_style(native, declared):
    style = native if declared is None else declared
    if style not in ("metal", "real"):
        raise ValueError("unit_style must be metal or real (supply it when absent from the file)")
    if native is not None and native != style:
        raise ValueError(f"unit_style {style!r} conflicts with file units {native!r}")
    return style


def _thermo_row(fields):
    return {
        name: _integer(value, name) if name.casefold() == "step" else _number(value, name)
        for name, value in fields
    }


def analyze_thermo(filename: str, data: bytes, options: dict) -> dict:
    """Return native thermo values and a per-column unit map.

    Native log units are used when present. Pass unit_style for a JSONL export
    or a log with no units command in its echo. Unknown column units are null.
    Blocks are half-open row ranges, in file order. The log supplies headers
    at run boundaries. For flat JSONL, a repeated or decreasing Step starts a
    new block when adjacent rows have a Step value.
    """
    _bounded(data, _LIMITS["max_bytes"], filename)
    stream = io.BytesIO(data)
    native = None
    jsonl = filename.lower().endswith(".jsonl")
    rows = []
    columns = {}
    blocks = []
    start_block = True
    header = None
    line_no = 0
    try:
        for line_no, raw in enumerate(
            iter(lambda: stream.readline(_LIMITS["max_line_bytes"] + 1), b""), 1
        ):
            if len(raw) > _LIMITS["max_line_bytes"]:
                raise ValueError("line exceeds max_line_bytes")
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            if jsonl:
                fields = json.loads(line)
                if not isinstance(fields, dict) or not fields:
                    raise ValueError("expected a JSON object with thermo fields")
                row = _thermo_row(fields.items())
                if rows and "Step" in row and "Step" in rows[-1]:
                    start_block = row["Step"] <= rows[-1]["Step"]
            else:
                tokens = line.split()
                if tokens[0] == "units" and len(tokens) >= 2:
                    if native not in (None, tokens[1]):
                        raise ValueError("log mixes LAMMPS unit styles")
                    native = tokens[1]
                    continue
                if "Step" in tokens and ":" not in line:
                    header = tokens
                    start_block = True
                    continue
                if header is None or tokens[0] == "WARNING:":
                    continue
                try:
                    float(tokens[0])
                except ValueError:
                    header = None
                    continue
                if len(tokens) != len(header):
                    raise ValueError("thermo row does not match its header")
                row = _thermo_row(zip(header, tokens))
            if start_block:
                blocks.append({"start_row": len(rows), "end_row": len(rows)})
                start_block = False
            rows.append(row)
            blocks[-1]["end_row"] = len(rows)
            columns.update(dict.fromkeys(row))
            if len(rows) > _LIMITS["max_frames"] or len(columns) > 128:
                raise ValueError("thermo exceeds the limit of 10000 rows or 128 columns")
        if not rows:
            raise ValueError("no LAMMPS thermo rows found")
        style = _unit_style(native, options.get("unit_style"))
    except (ValueError, RecursionError) as exc:
        raise ValueError(f"{filename}:{line_no}: {exc}") from exc
    native_units = _STYLES[style]
    units = {
        name: "step" if name.casefold() == "step"
        else native_units.get(_THERMO_QUANTITIES.get(name.casefold()))
        for name in columns
    }
    return {"kind": "thermo", "unit_style": style, "columns": list(columns),
            "units": units, "rows": rows, "blocks": blocks}


def _box(reader):
    fields = reader.expect("ITEM:", "BOX", "BOUNDS")
    general = fields[:2] == ["abc", "origin"]
    tilted = fields[:3] == ["xy", "xz", "yz"]
    width = 4 if general else 3 if tilted else 2
    rows = [[_number(value, "BOX BOUNDS") for value in reader.row(width, "BOX BOUNDS")]
            for _ in range(3)]
    if general:
        return [row[3] for row in rows], [row[:3] for row in rows]
    (xlo, xhi), (ylo, yhi), (zlo, zhi) = (row[:2] for row in rows)
    xy, xz, yz = (row[2] for row in rows) if tilted else (0.0, 0.0, 0.0)
    # Restricted triclinic dumps report bounding extents, not true cell limits.
    xlo -= min(0.0, xy, xz, xy + xz)
    xhi -= max(0.0, xy, xz, xy + xz)
    ylo -= min(0.0, yz)
    yhi -= max(0.0, yz)
    return (xlo, ylo, zlo), ((xhi - xlo, 0.0, 0.0), (xy, yhi - ylo, 0.0), (xz, yz, zhi - zlo))


def _coordinates(columns):
    for names, scaled, wrapped, method in (
        (("xu", "yu", "zu"), False, False, "cartesian_unwrapped"),
        (("xsu", "ysu", "zsu"), True, False, "scaled_unwrapped"),
        (("x", "y", "z"), False, True, "cartesian_image_flags"),
        (("xs", "ys", "zs"), True, True, "scaled_image_flags"),
    ):
        fields = names + (("ix", "iy", "iz") if wrapped else ())
        if all(name in columns for name in fields):
            return [columns.index(name) for name in fields], scaled, wrapped, method
    raise ValueError("unwrapped coordinates unavailable: supply xu/yu/zu, xsu/ysu/zsu, "
                     "or wrapped x/y/z or xs/ys/zs with all ix/iy/iz image flags")


def _position(row, indices, scaled, wrapped, origin, vectors):
    position = [_number(row[index], "atom coordinate") for index in indices[:3]]
    if wrapped:
        images = [_integer(row[index], "image flag", minimum=-(2**63)) for index in indices[3:]]
        if scaled:
            position = [value + image for value, image in zip(position, images)]
        else:
            position = [value + math.fsum(image * edge[axis] for image, edge in zip(images, vectors))
                        for axis, value in enumerate(position)]
    if scaled:
        position = [offset + math.fsum(value * edge[axis] for value, edge in zip(position, vectors))
                    for axis, offset in enumerate(origin)]
    return position


def _selected_values(options, name):
    values = options.get(name)
    if values is None:
        return None
    if not isinstance(values, (list, tuple)) or not values:
        raise ValueError(f"{name} must be a nonempty list of positive integers")
    return {_integer(value, name, 1) for value in values}


def _fit(rows, options, dimension):
    start = options.get("fit_start_ps")
    end = options.get("fit_end_ps")
    start = min(row["time_ps"] for row in rows) if start is None else _number(start, "fit_start_ps")
    end = max(row["time_ps"] for row in rows) if end is None else _number(end, "fit_end_ps")
    if start > end:
        raise ValueError("fit_start_ps must be at or before fit_end_ps")
    points = [(row["time_ps"], row["msd_a2"]) for row in rows if start <= row["time_ps"] <= end]
    if len(points) < 2:
        raise ValueError("fit window requires at least two samples with distinct times")
    times, values = zip(*points)
    try:
        slope, intercept = linear_regression(times, values)
    except ValueError as exc:
        raise ValueError("fit window requires at least two samples with distinct times") from exc
    slope = _number(slope, "fit slope")
    intercept = _number(intercept, "fit intercept")
    diffusion = slope / (2 * dimension)
    return {"start_ps": start, "end_ps": end, "n_points": len(points),
            "slope_a2_per_ps": slope, "intercept_a2": intercept,
            "diffusion_a2_per_ps": diffusion, "diffusion_m2_per_s": diffusion * 1e-8}


def analyze_msd(filename: str, data: bytes, options: dict) -> dict:
    """Fit the mean squared displacement from the first frame of a text dump.

    Select first-frame atom IDs by intersection of atom_ids and atom_types
    when both are present. With neither, select all atoms in the first frame.
    Use timestep_ps when provided, otherwise use native ITEM: TIME converted
    to ps. Times and inclusive fit bounds are relative to the first frame.

    remove_drift subtracts the displacement of the selected group's center of
    mass. Use first-frame dump masses, or supply masses_by_type if the dump has
    no mass column. With neither available, use and report equal weights.
    """
    _bounded(data, _LIMITS["max_bytes"], filename)
    axes = options.get("axes", "xyz")
    if axes not in _AXES:
        raise ValueError("axes must be one of xyz, xy, xz, yz, x, y, z")
    components = ["xyz".index(axis) for axis in axes]
    atom_ids = _selected_values(options, "atom_ids")
    atom_types = _selected_values(options, "atom_types")
    remove_drift = options.get("remove_drift", False)
    if type(remove_drift) is not bool:
        raise ValueError("remove_drift must be a boolean")
    masses_by_type = options.get("masses_by_type")
    if remove_drift and masses_by_type is not None:
        if not isinstance(masses_by_type, dict):
            raise ValueError("masses_by_type must map atom types to positive masses")
        masses_by_type = {_integer(key, "mass atom type", 1): _number(value, "mass")
                          for key, value in masses_by_type.items()}
    timestep = options.get("timestep_ps")
    if timestep is not None:
        timestep = _number(timestep, "timestep_ps")
        if timestep <= 0:
            raise ValueError("timestep_ps must be positive")

    reader = _Dump(data, _LIMITS["max_line_bytes"])
    rows = []
    total_atoms = 0
    style = options.get("unit_style")
    reference = {}
    weights = {}
    weight_source = None
    methods = set()
    try:
        header = reader.read(optional=True)
        while header is not None:
            first = not rows
            if header == ["ITEM:", "UNITS"]:
                style = _unit_style(reader.row(1, "UNITS")[0], style)
                header = reader.read()
            elif first:
                style = _unit_style(None, style)
            timestamp = None
            if header == ["ITEM:", "TIME"]:
                timestamp = _number(reader.row(1, "TIME")[0], "TIME")
                header = reader.read()
            if header != ["ITEM:", "TIMESTEP"]:
                raise ValueError("expected ITEM: TIMESTEP")
            step = _integer(reader.row(1, "TIMESTEP")[0], "timestep")
            reader.expect("ITEM:", "NUMBER", "OF", "ATOMS")
            count = _integer(reader.row(1, "atom count")[0], "atom count")
            total_atoms += count
            if (len(rows) >= _LIMITS["max_frames"] or count > _LIMITS["max_atoms_per_frame"]
                    or total_atoms > _LIMITS["max_total_atoms"]):
                raise ValueError("dump exceeds the frame or atom record limit")
            origin, vectors = _box(reader)
            columns = reader.expect("ITEM:", "ATOMS")
            indices, scaled, wrapped, method = _coordinates(columns)
            methods.add(method)
            if "id" not in columns:
                raise ValueError("ATOMS requires id for trajectory tracking")
            id_col = columns.index("id")
            mass_col = columns.index("mass") if remove_drift and first and "mass" in columns else None
            use_mass_map = remove_drift and first and mass_col is None and masses_by_type is not None
            type_col = None
            if first and (atom_types is not None or use_mass_map):
                if "type" not in columns:
                    raise ValueError("ATOMS requires type for atom_types or masses_by_type")
                type_col = columns.index("type")
            if first and remove_drift:
                weight_source = ("dump_mass" if mass_col is not None else
                                 "masses_by_type" if use_mass_map else "equal")
            positions = {}
            for _ in range(count):
                atom = reader.row(len(columns), "atom row")
                atom_id = _integer(atom[id_col], "atom id", 1)
                if first:
                    if atom_ids is not None and atom_id not in atom_ids:
                        continue
                    atom_type = _integer(atom[type_col], "atom type", 1) if type_col is not None else None
                    if atom_types is not None and atom_type not in atom_types:
                        continue
                    if remove_drift:
                        if mass_col is not None:
                            mass = _number(atom[mass_col], "mass")
                        elif use_mass_map:
                            mass = masses_by_type.get(atom_type)
                            if mass is None:
                                raise ValueError(f"masses_by_type is missing atom type {atom_type}")
                        else:
                            mass = 1.0
                        if mass <= 0:
                            raise ValueError("selected atom masses must be positive")
                        weights[atom_id] = mass
                elif atom_id not in reference:
                    continue
                position = _position(atom, indices, scaled, wrapped, origin, vectors)
                positions[atom_id] = [_number(position[axis], "unwrapped coordinate") for axis in components]
            if first:
                if not positions:
                    raise ValueError("atom selection matches no atoms in the first frame")
                reference = positions
                step_origin = step
                native_time_origin = timestamp
                if remove_drift:
                    total_mass = math.fsum(weights.values())
                    weights = {atom_id: mass / total_mass for atom_id, mass in weights.items()}
            elif missing := reference.keys() - positions.keys():
                raise ValueError(f"step {step} is missing selected atom id {min(missing)}")

            if timestep is None:
                if timestamp is None:
                    raise ValueError("supply timestep_ps when ITEM: TIME is absent from any frame")
                elapsed = (timestamp - native_time_origin) * _PICOSECONDS[_STYLES[style]["time"]]
            else:
                elapsed = (step - step_origin) * timestep

            displacements = [
                [value - initial for value, initial in zip(positions[atom_id], reference[atom_id])]
                for atom_id in reference
            ]
            drift = [0.0] * len(components)
            if remove_drift:
                drift = [math.fsum(weights[atom_id] * delta[axis]
                                   for atom_id, delta in zip(reference, displacements))
                         for axis in range(len(components))]
            msd = math.fsum((value - offset) ** 2 for delta in displacements
                            for value, offset in zip(delta, drift)) / len(reference)
            rows.append({"step": step, "time_ps": _number(elapsed, "elapsed time"),
                         "msd_a2": _number(msd, "MSD")})
            header = reader.read(optional=True)
        if not rows:
            raise ValueError("dump contains no frames")
        fit = _fit(rows, options, len(components))
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"{filename}:{reader.line}: {exc}") from exc

    origin_time_ps = None
    if timestep is None:
        origin_time_ps = native_time_origin * _PICOSECONDS[_STYLES[style]["time"]]
    if atom_ids is not None and atom_types is not None:
        selection_mode = "intersection"
    elif atom_ids is not None:
        selection_mode = "atom_ids"
    elif atom_types is not None:
        selection_mode = "atom_types"
    else:
        selection_mode = "all"
    return {
        "kind": "msd", "unit_style": style, "method": "single_origin",
        "units": {"time_ps": "ps", "msd_a2": "angstrom^2"},
        "axes": axes, "dimension": len(components),
        "coordinate_mode": "unwrapped",
        "unwrapping_method": next(iter(methods)) if len(methods) == 1 else "mixed",
        "unwrapping_methods": sorted(methods),
        "selection": {"atom_ids": [str(atom_id) for atom_id in sorted(atom_ids)] if atom_ids else None,
                      "atom_types": sorted(atom_types) if atom_types else None,
                      "selected_atom_ids": [str(atom_id) for atom_id in sorted(reference)],
                      "atom_count": len(reference), "mode": selection_mode},
        "remove_drift": remove_drift, "drift_weighting": weight_source,
        "time_source": "item_time" if timestep is None else "timestep_ps",
        "time_origin": {"step": step_origin, "native_time_ps": origin_time_ps},
        "rows": rows, "fit": fit,
    }
