"""Sample equipment fields in physical mesh coordinates."""

import json
import math

import numpy as np
from jsonschema import ValidationError

from .imports import _compare_profile_reference, validate_equipment


# VTK hexahedron node order, in the unit reference cube.
_CORNERS = np.array([
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
])
_SIGNS = 2 * _CORNERS - 1
_ROUNDOFF = 64 * np.finfo(float).eps
_MAX_TOTAL_SAMPLES = 10_000


def _factors(q):
    return np.where(_CORNERS, q, 1 - q)


def _jacobian(nodes, q):
    factors = _factors(q)
    return nodes.T @ (_SIGNS * factors[:, [1, 2, 0]] * factors[:, [2, 0, 1]])


class _Cell:
    def __init__(self, points, cell, index):
        self.index = index
        kind = cell["vtk_type"]
        if kind not in (10, 11, 12):
            raise ValueError(f"cell {index}: unsupported VTK probe cell type {kind}")
        self.ids = np.array(cell["point_indices"])
        if kind == 11:
            self.ids = self.ids[[0, 1, 3, 2, 4, 5, 7, 6]]
        vertices = points[self.ids]
        self.origin = vertices[0]
        self.scale = float(np.max(np.ptp(vertices, axis=0)))
        if not math.isfinite(self.scale) or self.scale <= 0:
            raise ValueError(f"cell {index}: invalid cell extent")
        padding = _ROUNDOFF * self.scale
        self.low = vertices.min(axis=0) - padding
        self.high = vertices.max(axis=0) + padding
        nodes = (vertices - self.origin) / self.scale
        self.tetra = kind == 10
        matrix = nodes[1:].T if self.tetra else _jacobian(nodes, np.full(3, 0.5))
        try:
            if np.linalg.cond(matrix) > 1e10 or np.linalg.det(matrix) <= 0:
                raise np.linalg.LinAlgError()
            self.inverse = np.linalg.inv(matrix)
        except np.linalg.LinAlgError as exc:
            raise ValueError(f"cell {index}: degenerate, inverted or ill-conditioned geometry") from exc
        if not self.tetra:
            self.nodes = nodes @ self.inverse.T
            # Each Jacobian entry is multiaffine. Its extrema lie at corners.
            # This bounds the infinity norm of I-J everywhere in the cube.
            deviations = [np.abs(np.eye(3) - _jacobian(self.nodes, q)) for q in _CORNERS]
            bound = np.max(np.max(deviations, axis=0).sum(axis=1))
            if bound >= 0.9:
                raise ValueError(f"cell {index}: hexahedron distortion exceeds supported inverse-map bound")
        self.tolerance = _ROUNDOFF * max(1, np.linalg.norm(self.inverse, ord=np.inf))

    def weights(self, point):
        target = self.inverse @ ((point - self.origin) / self.scale)
        if self.tetra:
            weights = np.r_[1 - target.sum(), target]
            if np.min(weights) < -self.tolerance:
                return None
            weights = np.maximum(weights, 0)
            return weights / weights.sum()

        # Projection yields a contraction on the cube. A projected fixed
        # point is inside only if the physical mapping also matches.
        q = np.clip(target, 0, 1)
        for _ in range(400):
            weights = _factors(q).prod(axis=1)
            residual = target - weights @ self.nodes
            if np.max(np.abs(residual)) <= self.tolerance:
                return weights
            updated = np.clip(q + residual, 0, 1)
            if np.max(np.abs(updated - q)) <= _ROUNDOFF:
                return None
            q = updated
        raise ValueError(f"cell {self.index}: hexahedron inverse map did not converge")


class _Bounds:
    """Balanced bounding-volume tree over physical cell AABBs."""

    def __init__(self, cells, lows, highs, centers, ids):
        self.low = lows[ids].min(axis=0)
        self.high = highs[ids].max(axis=0)
        if len(ids) <= 8:
            self.cells = [cells[index] for index in ids]
            self.children = ()
        else:
            axis = np.argmax(np.ptp(centers[ids], axis=0))
            middle = len(ids) // 2
            ids = ids[np.argpartition(centers[ids, axis], middle)]
            self.cells = ()
            self.children = tuple(
                _Bounds(cells, lows, highs, centers, half)
                for half in (ids[:middle], ids[middle:])
            )

    def candidates(self, point):
        if np.any(point < self.low) or np.any(point > self.high):
            return
        for cell in self.cells:
            if np.all(point >= cell.low) and np.all(point <= cell.high):
                yield cell
        for child in self.children:
            yield from child.candidates(point)


def _number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _check_sample_budget(profiles, label):
    total = 0
    for index, profile in enumerate(profiles):
        if not isinstance(profile, dict):
            raise ValueError(f"{label} {index}: expected a profile object")
        fractions = profile.get("fractions")
        count = profile.get("count")
        if isinstance(fractions, list):
            total += len(fractions)
        elif type(count) is int and count >= 2:
            total += count
        if total > _MAX_TOTAL_SAMPLES:
            raise ValueError(
                f"{label} {index}: total sampling budget exceeds {_MAX_TOTAL_SAMPLES} samples"
            )


def _profile_spec(profile, label, *, reference=False):
    if not isinstance(profile, dict):
        raise ValueError(f"{label}: expected a profile object")
    a, b = profile.get("a"), profile.get("b")
    if any(not isinstance(p, list) or len(p) != 3 or not all(map(_number, p)) for p in (a, b)) or a == b:
        raise ValueError(f"{label}: expected distinct finite 3D endpoints")
    field = profile.get("field")
    if (
        not isinstance(field, dict) or set(field) != {"name", "association", "selection"}
        or field["association"] not in ("point", "cell")
        or not isinstance(field["name"], str) or not field["name"].strip()
    ):
        raise ValueError(f"{label}: invalid field selector")
    selection = field["selection"]
    if isinstance(selection, dict) and selection == {"kind": "magnitude"}:
        component = None
    elif (
        isinstance(selection, dict) and set(selection) == {"kind", "index"}
        and selection["kind"] == "component"
        and type(selection["index"]) is int and selection["index"] >= 0
    ):
        component = selection["index"]
    else:
        raise ValueError(f"{label}: invalid component or magnitude selection")

    if "fractions" in profile and "count" not in profile:
        fractions = profile["fractions"]
        if (
            not isinstance(fractions, list) or len(fractions) < 2
            or not all(map(_number, fractions)) or fractions[0] != 0 or fractions[-1] != 1
            or any(left >= right for left, right in zip(fractions, fractions[1:]))
        ):
            raise ValueError(f"{label}: fractions must increase strictly from 0 to 1")
    elif not reference and "fractions" not in profile and type(profile.get("count")) is int and profile["count"] >= 2:
        steps = profile["count"] - 1
        fractions = [index / steps for index in range(steps + 1)]
    else:
        raise ValueError(f"{label}: supply fractions or an integer count of at least 2")

    key = (tuple(a), tuple(b), field["association"], field["name"], component, tuple(fractions))
    return key, {"a": a, "b": b, "field": field}, fractions


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _invalid_json_constant(token):
    raise ValueError(f"invalid JSON constant {token}")


def _references(reference, length_unit):
    if reference is None:
        return {}
    if not isinstance(reference, dict):
        raise ValueError("reference: expected a JSON object")
    if set(reference) != {"length_unit", "profiles"}:
        raise ValueError("reference: expected exactly length_unit and profiles")
    if reference.get("length_unit") != length_unit:
        raise ValueError(f"reference length unit mismatch: mesh={length_unit!r}, reference={reference.get('length_unit')!r}")
    profiles = reference.get("profiles")
    if not isinstance(profiles, list) or not profiles:
        raise ValueError("reference: expected a nonempty profiles array")
    _check_sample_budget(profiles, "reference profile")
    required = {"a", "b", "field", "fractions", "unit", "values", "absolute_tolerance"}
    allowed = required | {"relative_tolerance"}
    by_key = {}
    for index, profile in enumerate(profiles):
        label = f"reference profile {index}"
        if not required <= profile.keys() <= allowed:
            raise ValueError(f"{label}: invalid reference profile keys")
        if not isinstance(profile["unit"], str) or not profile["unit"].strip():
            raise ValueError(f"{label}: expected a nonempty field unit")
        key, _, fractions = _profile_spec(profile, label, reference=True)
        if key in by_key:
            raise ValueError(f"{label}: ambiguous duplicate reference profile")
        values = profile.get("values")
        if (
            not isinstance(values, list) or len(values) != len(fractions)
            or any(value is not None and not _number(value) for value in values)
        ):
            raise ValueError(f"{label}: expected one finite value or null per fraction")
        for name in ("absolute_tolerance", "relative_tolerance"):
            tolerance = profile.get(name, 0 if name == "relative_tolerance" else None)
            if not _number(tolerance) or tolerance < 0:
                raise ValueError(f"{label}: {name} must be finite and nonnegative")
        by_key[key] = profile
    return by_key


def _compare(index, profile, reference):
    samples = profile["samples"]
    if reference.get("unit") != profile["unit"]:
        raise ValueError(
            f"profile {index} reference unit mismatch: mesh={profile['unit']!r}, "
            f"reference={reference.get('unit')!r}"
        )
    magnitude = profile["field"]["selection"]["kind"] == "magnitude"
    try:
        _compare_profile_reference(samples, reference, profile["unit"], magnitude, ())
    except ValidationError as exc:
        sample_index = exc.path[-1]
        sample = samples[sample_index]
        expected = reference["values"][sample_index]
        raise ValueError(
            f"profile {index} sample {sample_index} (fraction {sample['fraction']}): "
            f"{exc.message}; computed={sample['value']!r}, reference={expected!r}"
        ) from exc


def _sample(tree, point, field, values, component):
    if tree is not None:
        for cell in sorted(tree.candidates(point), key=lambda candidate: candidate.index):
            weights = cell.weights(point)
            if weights is None:
                continue
            data = weights @ values[cell.ids] if field["association"] == "point" else values[cell.index]
            value = math.hypot(*data) if component is None else float(data[component])
            if not math.isfinite(value):
                raise ValueError("Sampled field value is not finite")
            return value
    return None


def read_import(filename, content, options, raw_id, reference=None):
    """Return a validated equipment record and a UI-ready sampling summary."""
    from .vtu_reader import read_mesh

    result = read_mesh(filename, content, options, raw_id)
    reference_id = None
    if isinstance(reference, tuple) and len(reference) == 3:
        reference_filename, reference_content, reference_id = reference
        try:
            reference = json.loads(
                reference_content, object_pairs_hook=_unique_json_object,
                parse_constant=_invalid_json_constant,
            )
        except (ValueError, TypeError, RecursionError) as exc:
            raise ValueError(f"{reference_filename}: invalid reference JSON: {exc}") from exc
        if not isinstance(reference, dict):
            raise ValueError(f"{reference_filename}: expected a reference JSON object")
    references = _references(reference, result["length_unit"])
    requested = options.get("profiles", list(references.values()))
    if not isinstance(requested, list):
        raise ValueError("options.profiles must be an array")

    _check_sample_budget(requested, "profile")
    specs = [_profile_spec(profile, f"profile {index}") for index, profile in enumerate(requested)]
    if references:
        keys = [key for key, _, _ in specs]
        if len(set(keys)) != len(keys):
            raise ValueError("ambiguous duplicate requested profile")
        if references.keys() - set(keys):
            raise ValueError("unmatched reference profile (check endpoints, field selection and fractions)")

    details = {
        "origin": "vtu", "raw_id": raw_id, "filename": filename,
        "length_unit": result["length_unit"], "point_count": len(result["points"]),
        "cell_count": len(result["cells"]), "field_count": len(result["fields"]),
        "profiles": [], "reference_profile_count": len(references),
    }
    if specs:
        points = np.asarray(result["points"], dtype=float)
        cells = [_Cell(points, cell, index) for index, cell in enumerate(result["cells"])]
        tree = None
        if cells:
            lows = np.array([cell.low for cell in cells])
            highs = np.array([cell.high for cell in cells])
            tree = _Bounds(cells, lows, highs, lows / 2 + highs / 2, np.arange(len(cells)))
        fields = {(field["association"], field["name"]): field for field in result["fields"]}
        arrays = {}
        profiles = []
        for index, (key, profile, fractions) in enumerate(specs):
            field_key = key[2:4]
            field = fields.get(field_key)
            component = key[4]
            if field is None:
                raise ValueError(f"profile {index}: unknown field {field_key}")
            if (component is None and field["components"] < 2) or (
                component is not None and component >= field["components"]
            ):
                raise ValueError(f"profile {index}: invalid selection for field {field_key}")
            if field_key not in arrays:
                arrays[field_key] = np.asarray(field["values"], dtype=float)
            a, b = np.asarray(profile["a"], dtype=float), np.asarray(profile["b"], dtype=float)
            samples = [
                {"fraction": fraction, "value": _sample(
                    tree, (1 - fraction) * a + fraction * b, field, arrays[field_key], component
                )}
                for fraction in fractions
            ]
            profile.update(coordinate_frame="mesh", unit=field["unit"], samples=samples)
            expected = references.get(key)
            if expected is not None:
                _compare(index, profile, expected)
                if reference_id is not None:
                    profile["reference"] = {
                        "source": "user_provided", "reference_artifact_id": reference_id,
                        **{
                            name: expected[name]
                            for name in ("values", "unit", "absolute_tolerance", "relative_tolerance")
                            if name in expected
                        },
                    }
            profiles.append(profile)
            details["profiles"].append({
                "field": profile["field"], "unit": profile["unit"],
                "sample_count": len(samples),
                "outside_count": sum(sample["value"] is None for sample in samples),
                "reference_matched": expected is not None,
            })
        result["line_profiles"] = profiles
    validate_equipment(result)
    return result, details
