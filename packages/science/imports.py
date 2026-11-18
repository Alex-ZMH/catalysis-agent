"""Validate normalized import records against v1 schemas and cross-record rules."""

from fractions import Fraction

from jsonschema import ValidationError

from packages.contracts import validate_schema


def _check_timeline(rows, mode, path):
    explicit = mode == "explicit"
    for index, row in enumerate(rows):
        if explicit != ("time" in row):
            raise ValidationError(
                "Row time must be supplied exactly in explicit mode",
                path=(*path, index, "time"),
            )
        if index == 0:
            continue
        previous = rows[index - 1]
        if row["timestep"] <= previous["timestep"]:
            raise ValidationError(
                "Timesteps must be strictly increasing within each stream",
                path=(*path, index, "timestep"),
            )
        if explicit and row["time"] <= previous["time"]:
            raise ValidationError(
                "Explicit times must be strictly increasing within each stream",
                path=(*path, index, "time"),
            )


def validate_md(instance: dict) -> None:
    """Validate normalized LAMMPS dumps and/or time series."""
    validate_schema("md.schema.json", instance)

    if "dump" in instance:
        frames = instance["dump"]["frames"]
        _check_timeline(frames, instance["dump"]["time"]["mode"], ("dump", "frames"))
        for frame_index, frame in enumerate(frames):
            a, b, c = [
                [_decimal_value(value) for value in vector]
                for vector in frame["cell"]["vectors"]
            ]
            determinant = (
                a[0] * (b[1] * c[2] - b[2] * c[1])
                - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
            )
            if not determinant:
                raise ValidationError(
                    "MD cell vectors must enclose a nonzero volume",
                    path=("dump", "frames", frame_index, "cell", "vectors"),
                )
            seen = set()
            for atom_index, atom in enumerate(frame["atoms"]):
                if atom["id"] in seen:
                    raise ValidationError(
                        "Atom IDs must be unique within a frame",
                        path=("dump", "frames", frame_index, "atoms", atom_index, "id"),
                    )
                seen.add(atom["id"])

    if "time_series" in instance:
        series = instance["time_series"]
        names = {column["name"] for column in series["columns"]}
        if len(names) != len(series["columns"]):
            raise ValidationError(
                "Time-series column names must be unique", path=("time_series", "columns")
            )
        _check_timeline(series["samples"], series["time"]["mode"], ("time_series", "samples"))
        for index, sample in enumerate(series["samples"]):
            if len(sample["values"]) != len(names):
                raise ValidationError(
                    "Expected one scalar per time-series column",
                    path=("time_series", "samples", index, "values"),
                )


def _decimal_value(value):
    # Preserve the decimal representation at inclusive tolerance boundaries.
    return Fraction(str(value) if isinstance(value, float) else value)


def _validate_profile(profile, fields, path):
    selector = profile["field"]
    field = fields.get((selector["association"], selector["name"]))
    if field is None:
        raise ValidationError("Profile field does not exist", path=(*path, "field"))

    selection = selector["selection"]
    if selection["kind"] == "component":
        if selection["index"] >= field["components"]:
            raise ValidationError("Profile component is out of range", path=(*path, "field", "selection"))
    elif field["components"] < 2:
        raise ValidationError("Magnitude requires a vector field", path=(*path, "field", "selection"))

    if profile["unit"] != field["unit"]:
        raise ValidationError("Profile unit must match the field unit", path=(*path, "unit"))
    if profile["a"] == profile["b"]:
        raise ValidationError("Line endpoints must be distinct", path=(*path, "b"))

    samples = profile["samples"]
    if samples[0]["fraction"] != 0 or samples[-1]["fraction"] != 1:
        raise ValidationError("Profile must sample both line endpoints", path=(*path, "samples"))
    for index in range(1, len(samples)):
        if samples[index]["fraction"] <= samples[index - 1]["fraction"]:
            raise ValidationError(
                "Sample fractions must be strictly increasing", path=(*path, "samples", index, "fraction")
            )

    magnitude = selection["kind"] == "magnitude"
    if magnitude:
        for index, sample in enumerate(samples):
            if sample["value"] is not None and sample["value"] < 0:
                raise ValidationError("Magnitude must be nonnegative", path=(*path, "samples", index, "value"))

    if "reference" in profile:
        _compare_profile_reference(samples, profile["reference"], field["unit"], magnitude, (*path, "reference"))


def _compare_profile_reference(samples, reference, unit, magnitude, path):
    if reference["unit"] != unit:
        raise ValidationError("Reference unit must match the field unit", path=(*path, "unit"))
    if len(reference["values"]) != len(samples):
        raise ValidationError("Expected one reference value per sample", path=(*path, "values"))

    absolute = _decimal_value(reference["absolute_tolerance"])
    relative = _decimal_value(reference.get("relative_tolerance", 0))
    for index, (sample, expected) in enumerate(zip(samples, reference["values"])):
        actual = sample["value"]
        value_path = (*path, "values", index)
        if (actual is None) != (expected is None):
            raise ValidationError("Sample and reference masks must agree", path=value_path)
        if expected is not None:
            if magnitude and expected < 0:
                raise ValidationError("Reference magnitude must be nonnegative", path=value_path)
            expected = _decimal_value(expected)
            if abs(_decimal_value(actual) - expected) > absolute + relative * abs(expected):
                raise ValidationError("Sample exceeds the supplied reference tolerance", path=value_path)


# Fixed-arity linear VTK types supported by equipment.schema.json.
_CELL_ARITY = {1: 1, 3: 2, 5: 3, 8: 4, 9: 4, 10: 4, 11: 8, 12: 8, 13: 6, 14: 5}


def validate_equipment(instance: dict) -> None:
    """Validate normalized VTU mesh fields and optional user line profiles."""
    validate_schema("equipment.schema.json", instance)

    counts = {"point": len(instance["points"]), "cell": len(instance["cells"])}
    for index, cell in enumerate(instance["cells"]):
        if len(cell["point_indices"]) != _CELL_ARITY[cell["vtk_type"]]:
            raise ValidationError("Incorrect arity for the VTK cell type", path=("cells", index, "point_indices"))
        for slot, point_index in enumerate(cell["point_indices"]):
            if point_index >= counts["point"]:
                raise ValidationError(
                    "Cell references a missing mesh point",
                    path=("cells", index, "point_indices", slot),
                )

    fields = {}
    for index, field in enumerate(instance["fields"]):
        key = field["association"], field["name"]
        path = ("fields", index)
        if key in fields:
            raise ValidationError("Field names must be unique per association", path=(*path, "name"))
        fields[key] = field
        if len(field["values"]) != counts[field["association"]]:
            raise ValidationError(
                "Expected one value tuple per entity of the declared association",
                path=(*path, "values"),
            )
        for row, values in enumerate(field["values"]):
            if len(values) != field["components"]:
                raise ValidationError(
                    "Value tuple does not match the declared component count",
                    path=(*path, "values", row),
                )

    for index, profile in enumerate(instance.get("line_profiles", [])):
        _validate_profile(profile, fields, ("line_profiles", index))
