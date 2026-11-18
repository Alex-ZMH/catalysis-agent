"""Offline size checks and construction for an existing cleaved slab."""

from itertools import product
from math import hypot, isclose, isfinite
from os import getenv
from re import fullmatch

_AXES = ("a", "b", "c")
_CAP = 50.0
_DEFAULT_MAX_MODEL_ATOMS = "100000"


def _number(value):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("Expected a finite number") from error
    if isinstance(value, bool) or not isfinite(result):
        raise ValueError("Expected a finite number")
    return result


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    x, y, z = a
    u, v, w = b
    return y * w - z * v, z * u - x * w, x * v - y * u


def _geometry(vectors):
    try:
        rows = [tuple(_number(x) for x in row) for row in vectors]
    except TypeError as error:
        raise ValueError("Expected three lattice vectors") from error
    if len(rows) != 3 or any(len(row) != 3 for row in rows):
        raise ValueError("Expected three lattice vectors with three components each")
    lengths = [hypot(*row) for row in rows]
    if any(length <= 0 or not isfinite(length) for length in lengths):
        raise ValueError("Lattice lengths must be positive and finite")
    units = [tuple(x / length for x in row) for row, length in zip(rows, lengths)]
    if abs(_dot(_cross(*units[:2]), units[2])) <= 1e-12:
        raise ValueError("Lattice is singular or numerically degenerate")
    return rows, lengths, units


def check_cell(vectors, limits_A=None):
    """Check physical lattice-vector lengths against the effective per-axis caps."""
    _, lengths, _ = _geometry(vectors)
    if limits_A is None:
        limits_A = {}
    if isinstance(limits_A, (list, tuple)):
        if len(limits_A) != 3:
            raise ValueError("Ordered cell limits must contain a, b and c")
        limits_A = dict(zip(_AXES, limits_A))
    if not isinstance(limits_A, dict):
        limits_A = dict.fromkeys(_AXES, limits_A)
    if limits_A.keys() - set(_AXES):
        raise ValueError("Cell limits may only specify a, b and c")
    limits = {axis: _number(limits_A.get(axis, _CAP)) for axis in _AXES}
    if any(not 0 < limit <= _CAP for limit in limits.values()):
        raise ValueError("Cell limits must be positive and at most 50 angstrom")
    lengths = dict(zip(_AXES, lengths))
    exceeded = [axis for axis in _AXES if lengths[axis] > limits[axis]]
    return {
        "lengths_A": lengths,
        "limits_A": limits,
        "exceeded_axes": exceeded,
        "within_limit": not exceeded,
    }


def _parse(content):
    raw = content.decode("utf-8-sig").splitlines()
    if not raw:
        raise ValueError("Empty POSCAR")
    title, *lines = raw
    lines = [line.split() for line in lines]
    if len(lines) < 8 or len(lines[0]) != 1 or _number(lines[0][0]) <= 0:
        raise ValueError("Expected a VASP 5 POSCAR with one positive scale factor")
    scale = _number(lines[0][0])
    rows, lengths, units = _geometry(
        [[scale * _number(x) for x in row] for row in lines[1:4]]
    )
    if _dot(_cross(*units[:2]), units[2]) < 0:
        raise ValueError("VASP POSCAR requires a right-handed lattice")
    species = lines[4]
    if not species or any(not fullmatch(r"[A-Za-z][A-Za-z0-9_+-]*", s) for s in species):
        raise ValueError("Expected explicit POSCAR species labels")
    counts = lines[5]
    if len(counts) != len(species) or any(not fullmatch(r"[0-9]+", n) for n in counts):
        raise ValueError("Expected one atom count per POSCAR species")
    counts = [int(n) for n in counts]
    selective = [token.lower() for token in lines[6]] == ["selective", "dynamics"]
    mode_index = 7 if selective else 6
    mode = [token.lower() for token in lines[mode_index]]
    if mode not in (["direct"], ["cartesian"]):
        raise ValueError("Expected Direct or Cartesian POSCAR coordinates")
    atom_lines = lines[mode_index + 1:]
    count = sum(counts)
    if not count or len(atom_lines) < count or any(atom_lines[count:]):
        raise ValueError("Atom count mismatch or unsupported trailing POSCAR data")

    # Reciprocal directions convert scaled Cartesian input to fractional positions.
    reciprocal = [_cross(units[(i + 1) % 3], units[(i + 2) % 3]) for i in range(3)]
    atoms = []
    for line in atom_lines[:count]:
        flags = line[3:]
        if len(line) < 3 or len(flags) != (3 if selective else 0):
            raise ValueError("Unexpected POSCAR atom fields")
        if any(flag.upper() not in ("T", "F") for flag in flags):
            raise ValueError("Expected T/F selective dynamics flags")
        xyz = tuple(_number(x) for x in line[:3])
        if mode == ["cartesian"]:
            xyz = tuple(
                _number(_dot(xyz, dual) * scale / length / _dot(unit, dual))
                for dual, length, unit in zip(reciprocal, lengths, units)
            )
        atoms.append((tuple(x % 1 for x in xyz), flags))
    return title, rows, units, species, counts, atoms, selective


def _normal_gaps(atoms):
    layers = sorted({xyz[2] for xyz, _ in atoms})
    gaps = [(end - start, end) for start, end in zip(layers, layers[1:])]
    gaps.append((1.0 - layers[-1] + layers[0], layers[0]))
    return gaps


def _replace_vacuum(rows, atoms, vacuum, normal, height, gaps):
    a, b, c = rows
    gap, cut = max(gaps)
    if sum(isclose(size, gap, rel_tol=1e-9, abs_tol=1e-12) for size, _ in gaps) > 1:
        raise ValueError("Ambiguous slab: multiple largest normal gaps")
    offsets = [(xyz[2] - cut) % 1 for xyz, _ in atoms]
    thickness = max(offsets) * height
    new_height = thickness + vacuum
    lateral_c = tuple(x - height * n for x, n in zip(c, normal))
    new_c = tuple(x + new_height * n for x, n in zip(lateral_c, normal))
    return [a, b, new_c], cut, offsets, new_height, lateral_c


def plan_from_poscar(content: bytes, options: dict) -> dict:
    """Preflight an existing slab and emit a candidate only when it fits."""
    if not isinstance(options, dict) or options.keys() - {"repeats", "vacuum_A", "limits_A"}:
        raise ValueError("Expected options repeats, vacuum_A and limits_A")
    repeats = options.get("repeats", (1, 1, 1))
    if (not isinstance(repeats, (tuple, list)) or len(repeats) != 3
            or any(type(n) is not int or n <= 0 for n in repeats)):
        raise ValueError("repeats must contain three positive integers")
    vacuum = _number(options["vacuum_A"]) if "vacuum_A" in options else None
    if vacuum is not None and (vacuum <= 0 or repeats[2] != 1):
        raise ValueError("Vacuum replacement requires positive vacuum_A and c repeat 1")
    title, rows, units, species, counts, atoms, selective = _parse(content)
    normal = _cross(*units[:2])
    normal_length = hypot(*normal)
    normal = tuple(x / normal_length for x in normal)
    height = _dot(rows[2], normal)
    gaps = _normal_gaps(atoms)
    if vacuum is not None:
        new_rows, cut, offsets, new_height, lateral_c = _replace_vacuum(
            rows, atoms, vacuum, normal, height, gaps
        )
        slab_thickness = max(offsets) * height
    else:
        new_rows = rows
        slab_thickness = (1 - max(gaps)[0]) * height
    try:
        final_rows = [
            tuple(component * n for component in row) for row, n in zip(new_rows, repeats)
        ]
    except OverflowError as error:
        raise ValueError("Repeated cell exceeds numeric range") from error
    result = check_cell(final_rows, options.get("limits_A"))
    normal_period = _dot(final_rows[2], normal)
    if vacuum is None:
        # Count all equivalent vacuum gaps when replicating along c.
        slab_thickness *= repeats[2]
    copies = repeats[0] * repeats[1] * repeats[2]
    atom_count = len(atoms) * copies
    result.update(
        repeats=list(repeats),
        vacuum_A=vacuum,
        slab_thickness_A=slab_thickness,
        actual_vacuum_A=normal_period - slab_thickness,
        atom_count=atom_count,
    )
    if not result["within_limit"]:
        return result

    try:
        max_atoms = int(getenv("CATALYSIS_MAX_MODEL_ATOMS", _DEFAULT_MAX_MODEL_ATOMS))
    except ValueError as error:
        raise ValueError("CATALYSIS_MAX_MODEL_ATOMS must be a positive integer") from error
    if max_atoms <= 0:
        raise ValueError("CATALYSIS_MAX_MODEL_ATOMS must be a positive integer")
    if atom_count > max_atoms:
        raise ValueError(f"Model has {atom_count} atoms, above CATALYSIS_MAX_MODEL_ATOMS={max_atoms}")

    if vacuum is not None:
        # Relative to the cut, the old and new c vectors share the same
        # in-plane projection. Compensate for the changed fractional z.
        a, b = units[:2]
        dual_a, dual_b = _cross(b, normal), _cross(normal, a)
        lateral_a = _dot(lateral_c, dual_a) / _dot(a, dual_a) / hypot(*rows[0])
        lateral_b = _dot(lateral_c, dual_b) / _dot(b, dual_b) / hypot(*rows[1])
        transformed = []
        for ((x, y, _), flags), offset in zip(atoms, offsets):
            z = (offset * height + vacuum / 2) / new_height
            shift = cut + offset - z
            position = (_number(x + shift * lateral_a), _number(y + shift * lateral_b), z)
            transformed.append((position, flags))
        atoms = transformed

    lines = [title, "1.0", *(" ".join(map(str, row)) for row in final_rows),
             " ".join(species), " ".join(str(n * copies) for n in counts)]
    if selective:
        lines.append("Selective dynamics")
    lines.append("Direct")
    mapping = []
    for index, (xyz, flags) in enumerate(atoms):
        for image in product(*(range(n) for n in repeats)):
            position = [(x + i) / n for x, i, n in zip(xyz, image, repeats)]
            lines.append(" ".join([*map(str, position), *flags]))
            mapping.append({"source_index": index, "image": list(image)})
    result.update(poscar="\n".join(lines) + "\n", atom_mapping=mapping)
    return result
