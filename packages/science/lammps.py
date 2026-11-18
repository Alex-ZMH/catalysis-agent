"""Read bounded native LAMMPS text dumps into the v1 MD contract."""

import io
import json
import math
import re
from fractions import Fraction

from jsonschema import ValidationError

from .imports import validate_md

_UNITS = {
    "lj": ("1", "1"),
    "real": ("angstrom", "fs"),
    "metal": ("angstrom", "ps"),
    "si": ("m", "s"),
    "cgs": ("cm", "s"),
    "electron": ("bohr", "fs"),
    "micro": ("um", "us"),
    "nano": ("nm", "ns"),
}
_ANGSTROM_ALIASES = {"angstrom", "å", "ångström"}
_ALIASES = {"µm": "um", "μm": "um", "µs": "us", "μs": "us"}
_COORDINATES = {
    "x": (("x", "y", "z"), "wrapped", False),
    "xu": (("xu", "yu", "zu"), "unwrapped", False),
    "xs": (("xs", "ys", "zs"), "wrapped", True),
    "xsu": (("xsu", "ysu", "zsu"), "unwrapped", True),
}
DEFAULT_REFERENCE_BYTES = 32 * 1024**2
_LIMITS = {"max_bytes": 32 * 1024**2, "max_line_bytes": 64 * 1024,
           "max_frames": 10_000, "max_atoms_per_frame": 100_000,
           "max_total_atoms": 200_000, "max_reference_bytes": DEFAULT_REFERENCE_BYTES}


def _integer(value, label, minimum=0):
    if isinstance(value, str) and re.fullmatch(r"[+-]?[0-9]+", value):
        try:
            value = int(value)
        except ValueError:
            raise ValueError(f"{label} integer is too long") from None
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def _number(value, label):
    try:
        if type(value) not in (str, float, int) or (
            isinstance(value, str) and "_" in value
        ):
            raise ValueError
        result = float(value)
        if math.isfinite(result):
            return result
    except (ValueError, OverflowError):
        pass
    raise ValueError(f"{label} must be a finite number")


def _unit(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty unit label")
    return value.strip()


def _unit_key(value):
    if value.casefold() in _ANGSTROM_ALIASES:
        return "angstrom"
    return _ALIASES.get(value, value)


def _resolve_unit(options, key, inferred):
    if key not in options:
        return inferred
    declared = _unit(options[key], key)
    if inferred is not None and _unit_key(declared) != inferred:
        raise ValueError(f"{key} {declared!r} conflicts with dump unit {inferred!r}")
    return declared


def _bounded(content, limit, label):
    if not isinstance(content, bytes) or len(content) > limit:
        raise ValueError(f"{label} must be bytes, at most {limit} bytes")


class _Dump:
    def __init__(self, content, max_line):
        self.stream = io.BytesIO(content)
        self.max_line = max_line
        self.line = 0

    def read(self, *, optional=False):
        while True:
            raw = self.stream.readline(self.max_line + 1)
            if not raw:
                if optional:
                    return None
                raise ValueError("truncated dump")
            self.line += 1
            if len(raw) > self.max_line:
                raise ValueError("line exceeds max_line_bytes")
            tokens = raw.decode("ascii").split()
            if tokens:
                return tokens

    def expect(self, *header):
        tokens = self.read()
        if tokens[:len(header)] != list(header):
            raise ValueError(f"expected {' '.join(header)}")
        return tokens[len(header):]

    def row(self, size, label):
        row = self.read()
        if len(row) != size:
            raise ValueError(f"{label} requires {size} fields")
        return row

    def cell(self, step):
        fields = self.expect("ITEM:", "BOX", "BOUNDS")
        tilted = fields[:3] == ["xy", "xz", "yz"]
        flags = [flag.lower() for flag in (fields[3:] if tilted else fields)]
        if len(flags) != 3 or any(not re.fullmatch(r"pp|[fsm]{2}", flag) for flag in flags):
            raise ValueError(f"step {step} unsupported BOX BOUNDS or boundary flags")
        rows = [[_number(value, f"step {step} BOX BOUNDS") for value in
                 self.row(3 if tilted else 2, "BOX BOUNDS")] for _ in range(3)]
        (xlo, xhi), (ylo, yhi), (zlo, zhi) = [row[:2] for row in rows]
        xy, xz, yz = (row[2] for row in rows) if tilted else (0.0, 0.0, 0.0)
        xlo -= min(0.0, xy, xz, xy + xz)
        xhi -= max(0.0, xy, xz, xy + xz)
        ylo -= min(0.0, yz)
        yhi -= max(0.0, yz)
        origin = [xlo, ylo, zlo]
        lx, ly, lz = xhi - xlo, yhi - ylo, zhi - zlo
        if not all(math.isfinite(v) for v in origin + [lx, ly, lz]) or min(lx, ly, lz) <= 0:
            raise ValueError(f"step {step} invalid box lengths or origin")
        return {"origin": origin, "vectors": [[lx, 0.0, 0.0], [xy, ly, 0.0], [xz, yz, lz]],
                "periodic": [flag == "pp" for flag in flags]}, flags

    def atoms(self, step, count, cell, selection):
        columns = self.expect("ITEM:", "ATOMS")
        if "id" not in columns or len(set(columns)) != len(columns):
            raise ValueError(f"step {step} ATOMS requires id and unique column names")
        key = next((key for key, (names, _, _) in _COORDINATES.items()
                    if selection in (None, key) and all(name in columns for name in names)), None)
        if key is None:
            raise ValueError(f"step {step} ATOMS is missing a complete supported coordinate triplet")
        names, mode, scaled = _COORDINATES[key]
        indices = [columns.index(name) for name in names]
        id_index = columns.index("id")
        origin = cell["origin"]
        basis = list(zip(*cell["vectors"]))
        atoms = []
        seen = set()
        for _ in range(count):
            row = self.row(len(columns), f"step {step} atom")
            atom_id = _integer(row[id_index], f"step {step} atom id", 1)
            if atom_id in seen:
                raise ValueError(f"step {step} duplicate atom id {atom_id}")
            seen.add(atom_id)
            label = f"step {step} atom id {atom_id}"
            position = [_number(row[index], f"{label} axis {axis}")
                        for index, axis in zip(indices, "xyz")]
            if scaled:
                position = [_number(offset + sum(v * s for v, s in zip(vector, position)),
                                    f"{label} axis {axis}")
                            for axis, offset, vector in zip("xyz", origin, basis)]
            atoms.append({"id": atom_id, "position": position})
        return atoms, mode, key


def _time(options, frames, inferred):
    unit = _resolve_unit(options, "time_unit", inferred)
    if "dt" in options:
        if any("time" in frame for frame in frames):
            raise ValueError("dt and dump ITEM: TIME are mutually exclusive")
        dt = _number(options["dt"], "dt")
        if dt <= 0 or unit is None:
            raise ValueError("dt requires a positive value and a declared or mapped time_unit")
        step_origin = _integer(options.get("step_origin", 0), "step_origin")
        time_origin = _number(options.get("time_origin", 0), "time_origin")
        for frame in frames:
            _number(time_origin + (frame["timestep"] - step_origin) * dt,
                    f"step {frame['timestep']} mapped time")
        return {"mode": "constant_dt", "unit": unit, "dt": dt,
                "step_origin": step_origin, "time_origin": time_origin}
    if {"step_origin", "time_origin"}.intersection(options):
        raise ValueError("step_origin and time_origin require dt")
    if unit is not None and any("time" in frame for frame in frames):
        return {"mode": "explicit", "unit": unit}
    for frame in frames:
        frame.pop("time", None)
    return {"mode": "unknown"}


def _unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate JSON object key")
    return result


def _object(value, fields, label):
    if not isinstance(value, dict) or not set(fields.split()) <= value.keys():
        raise ValueError(f"{label} requires fields {fields}")
    return value


def _index(rows, key, label, minimum, limit):
    if not isinstance(rows, list) or len(rows) > limit:
        raise ValueError(f"{label} must be an array with at most {limit} entries")
    result = {}
    for row in rows:
        value = _object(row, key, label)[key]
        if type(value) is not int or value < minimum:
            raise ValueError(f"{label} {key} must be an integer >= {minimum}")
        if value in result:
            raise ValueError(f"{label} duplicate {key} {value}")
        result[value] = row
    return result


def _match_keys(actual, expected, label):
    missing = actual.keys() - expected.keys()
    extra = expected.keys() - actual.keys()
    if missing:
        raise ValueError(f"{label} missing from reference: {min(missing)}")
    if extra:
        raise ValueError(f"{label} only in reference: {min(extra)}")


def _compare_vector(actual, expected, tolerance, label):
    if not isinstance(expected, list) or len(expected) != 3:
        raise ValueError(f"{label} requires three components")
    maximum = Fraction()
    for axis, value, target in zip("xyz", actual, expected):
        component = f"{label} axis {axis}"
        if type(target) not in (float, int):
            raise ValueError(f"{component} requires a JSON number")
        _number(target, component)
        error = abs(Fraction(str(value)) - Fraction(str(target)))
        if error > tolerance:
            raise ValueError(f"{component} mismatch ({value} vs {target}) exceeds absolute_tolerance")
        maximum = max(maximum, error)
    return float(maximum)


def _verify(dump, checks, reference, limits):
    filename, content, artifact_id = reference
    if (not isinstance(artifact_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", artifact_id)
            or artifact_id == dump["raw_artifact_id"]):
        raise ValueError("reference requires a distinct independent raw artifact ID")
    try:
        _bounded(content, limits["max_reference_bytes"], "reference")
        data = _object(json.loads(content, object_pairs_hook=_unique_object),
                       "length_unit coordinate_mode absolute_tolerance frames", "reference")
        if _unit_key(_unit(data["length_unit"], "reference length_unit")) != _unit_key(dump["length_unit"]):
            raise ValueError("reference length_unit mismatch")
        if data["coordinate_mode"] != dump["coordinate_mode"]:
            raise ValueError("reference coordinate_mode mismatch")
        tolerance = data["absolute_tolerance"]
        if type(tolerance) not in (float, int) or _number(tolerance, "absolute_tolerance") < 0:
            raise ValueError("absolute_tolerance must be a finite nonnegative JSON number")
        tolerance = Fraction(str(tolerance))
        expected = _index(data["frames"], "timestep", "reference step", 0, limits["max_frames"])
        frames = {frame["timestep"]: frame for frame in dump["frames"]}
        _match_keys(frames, expected, "step")
        for step, check in zip(frames, checks):
            frame = frames[step]
            target = _object(expected[step], "cell atoms", f"step {step}")
            cell = frame["cell"]
            target_cell = _object(target["cell"], "origin vectors periodic", f"step {step} cell")
            pbc = target_cell["periodic"]
            if not isinstance(pbc, list) or len(pbc) != 3 or any(type(v) is not bool for v in pbc):
                raise ValueError(f"step {step} cell periodic requires three booleans")
            for axis, actual, wanted in zip("abc", cell["periodic"], pbc):
                if actual != wanted:
                    raise ValueError(f"step {step} cell periodic axis {axis} mismatch")
            if "boundary_flags" in target_cell:
                flags = target_cell["boundary_flags"]
                if not isinstance(flags, list) or len(flags) != 3:
                    raise ValueError(f"step {step} boundary_flags requires three strings")
                for axis, actual, wanted in zip("abc", check["boundary_flags"], flags):
                    if not isinstance(wanted, str) or actual != wanted.lower():
                        raise ValueError(f"step {step} boundary_flags axis {axis} mismatch")
            vectors = target_cell["vectors"]
            if not isinstance(vectors, list) or len(vectors) != 3:
                raise ValueError(f"step {step} cell requires three basis vectors")
            cell_error = _compare_vector(cell["origin"], target_cell["origin"],
                                         tolerance, f"step {step} cell origin")
            for axis, actual, wanted in zip("abc", cell["vectors"], vectors):
                cell_error = max(cell_error, _compare_vector(
                    actual, wanted, tolerance, f"step {step} cell vector {axis}"))
            atoms = {atom["id"]: atom for atom in frame["atoms"]}
            target_atoms = _index(target["atoms"], "id", f"step {step} atom", 1,
                                  limits["max_atoms_per_frame"])
            _match_keys(atoms, target_atoms, f"step {step} atom id")
            error = 0.0
            for atom_id, atom in atoms.items():
                label = f"step {step} atom id {atom_id}"
                position = _object(target_atoms[atom_id], "position", label)["position"]
                error = max(error, _compare_vector(atom["position"], position, tolerance, label))
            check.update(max_abs_error=error, max_cell_abs_error=cell_error)
    except (ValueError, RecursionError) as exc:
        raise ValueError(f"{filename}: {exc}") from exc
    return artifact_id


def compare_frozen(result, details, reference, *, max_reference_bytes=DEFAULT_REFERENCE_BYTES):
    """Compare a frozen v1 dump directly with an independently disclosed reference."""
    if not isinstance(result, dict) or "dump" not in result:
        raise ValueError("frozen MD comparison requires a dump")
    try:
        validate_md(result)
    except ValidationError as exc:
        raise ValueError(f"frozen MD result is invalid: {exc.message}") from exc

    if not isinstance(details, dict):
        raise ValueError("frozen MD details must be an object")
    dump = result.get("dump")
    checks = details.get("frame_checks")
    if not isinstance(checks, list) or len(checks) != len(dump["frames"]):
        raise ValueError("frozen MD details must contain one frame check per frame")

    frozen_checks = []
    for index, (frame, check) in enumerate(zip(dump["frames"], checks)):
        if not isinstance(check, dict) or check.get("timestep") != frame["timestep"]:
            raise ValueError(f"frozen MD frame check {index} does not match its frame")
        boundary_flags = check.get("boundary_flags")
        if (
            not isinstance(boundary_flags, list)
            or len(boundary_flags) != 3
            or any(not isinstance(flag, str) for flag in boundary_flags)
        ):
            raise ValueError(f"frozen MD frame check {index} has invalid boundary flags")
        frozen_checks.append(dict(check))

    if not isinstance(reference, tuple) or len(reference) != 3:
        raise ValueError("reference must be a (filename, bytes, artifact_id) tuple")
    atom_counts = [len(frame["atoms"]) for frame in dump["frames"]]
    limits = dict(_LIMITS, max_reference_bytes=max_reference_bytes)
    limits["max_frames"] = max(limits["max_frames"], len(dump["frames"]))
    limits["max_atoms_per_frame"] = max(limits["max_atoms_per_frame"], max(atom_counts, default=0))
    _verify(dump, frozen_checks, reference, limits)

    max_abs_error = 0.0
    max_cell_abs_error = 0.0
    for check in frozen_checks:
        max_abs_error = max(max_abs_error, check["max_abs_error"])
        max_cell_abs_error = max(max_cell_abs_error, check["max_cell_abs_error"])
    return {
        "frames": len(dump["frames"]),
        "atoms": sum(atom_counts),
        "max_abs_error": max_abs_error,
        "max_cell_abs_error": max_cell_abs_error,
        "length_unit": dump["length_unit"],
    }


def read_import(filename, content, options, raw_id, reference=None):
    """Return a validated v1 MD result and raw/reference comparison details."""
    options = {} if options is None else options
    if not isinstance(options, dict):
        raise ValueError("LAMMPS options must be an object")
    limits = {key: _integer(options.get(key, default), key, 1)
              for key, default in _LIMITS.items()}
    selection = options.get("coordinate_columns")
    if selection is not None and selection not in tuple(_COORDINATES):
        raise ValueError("coordinate_columns must be x, xu, xs, or xsu")
    _bounded(content, limits["max_bytes"], filename)
    reader = _Dump(content, min(limits["max_line_bytes"], limits["max_bytes"]))
    style = mode = None
    frames, checks = [], []
    total = 0
    try:
        header = reader.read(optional=True)
        while header is not None:
            if header == ["ITEM:", "UNITS"]:
                unit_style = reader.row(1, "UNITS")[0]
                if unit_style not in _UNITS or style not in (None, unit_style):
                    raise ValueError(f"unsupported or inconsistent UNITS style {unit_style!r}")
                style = unit_style
                header = reader.read()
            timestamp = None
            if header == ["ITEM:", "TIME"]:
                timestamp = _number(reader.row(1, "TIME")[0], "TIME")
                header = reader.read()
            if header != ["ITEM:", "TIMESTEP"]:
                raise ValueError("expected ITEM: TIMESTEP")
            step = _integer(reader.row(1, "TIMESTEP")[0], "timestep")
            if frames and step <= frames[-1]["timestep"]:
                raise ValueError(f"step {step} must be strictly increasing")
            if len(frames) >= limits["max_frames"]:
                raise ValueError("dump exceeds max_frames")
            if reader.expect("ITEM:", "NUMBER", "OF", "ATOMS"):
                raise ValueError("unexpected fields in ITEM: NUMBER OF ATOMS")
            count = _integer(reader.row(1, "atom count")[0], f"step {step} atom count")
            total += count
            if count > limits["max_atoms_per_frame"] or total > limits["max_total_atoms"]:
                raise ValueError(f"step {step} exceeds max_atoms_per_frame or max_total_atoms")
            cell, flags = reader.cell(step)
            atoms, frame_mode, columns = reader.atoms(step, count, cell, selection)
            if mode not in (None, frame_mode):
                raise ValueError(f"step {step} coordinate mode changes within dump")
            mode = frame_mode
            frame = {"timestep": step, "cell": cell, "atoms": atoms}
            if timestamp is not None:
                frame["time"] = timestamp
            frames.append(frame)
            checks.append({"timestep": step, "atom_count": count, "max_abs_error": None,
                           "boundary_flags": flags, "coordinate_columns": columns})
            header = reader.read(optional=True)
        if not frames:
            raise ValueError("dump contains no frames")
        inferred_length, inferred_time = _UNITS.get(style, (None, None))
        length = _resolve_unit(options, "length_unit", inferred_length)
        if length is None:
            raise ValueError("length_unit or dump ITEM: UNITS is required")
        time = _time(options, frames, inferred_time)
        dump = {"raw_artifact_id": raw_id, "length_unit": length, "coordinate_mode": mode,
                "frames": frames, "time": time}
        result = {"dump": dump}
        validate_md(result)
    except (ValueError, OverflowError, ValidationError) as exc:
        message = exc.message if isinstance(exc, ValidationError) else str(exc)
        raise ValueError(f"{filename}:{reader.line}: {message}") from exc

    details = {"frame_checks": checks, "reference_verified": False}
    if style is not None:
        details["unit_style"] = style
    if reference is not None:
        details["reference_artifact_id"] = _verify(dump, checks, reference, limits)
        details["reference_verified"] = True
    return result, details
