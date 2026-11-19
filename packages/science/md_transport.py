"""Fit signed transport coefficients from paired spatial LAMMPS samples."""

from fractions import Fraction
import csv
import io
import math
from statistics import fmean, linear_regression
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile
import zlib

from . import table
from .lammps import _integer, _number

_ANGSTROM = 1e-10
_EV = 1.602176634e-19
_AVOGADRO = 6.02214076e23
_KCAL_PER_PARTICLE = 4184 / _AVOGADRO
_GRAM_PER_MOLE_PER_PARTICLE = 1e-3 / _AVOGADRO
_POSITION = {"m": 1.0, "nm": 1e-9, "angstrom": _ANGSTROM}
_TIME = ("s", "ns", "ps", "fs", "step")
_HEAT_FLUX = {
    "W/m^2": 1.0,
    "eV/(angstrom^2*ps)": _EV / (_ANGSTROM**2 * 1e-12),
    "kcal/(mol*angstrom^2*fs)": _KCAL_PER_PARTICLE / (_ANGSTROM**2 * 1e-15),
}
_VELOCITY = {"m/s": 1.0, "nm/ns": 1.0, "angstrom/ps": 100.0, "angstrom/fs": 1e5}
_STRESS = {
    "Pa": 1.0, "kPa": 1e3, "MPa": 1e6, "GPa": 1e9, "bar": 1e5, "atm": 101325.0,
    "eV/angstrom^3": _EV / _ANGSTROM**3,
    "kcal/(mol*angstrom^3)": _KCAL_PER_PARTICLE / _ANGSTROM**3,
}
_CONCENTRATION = {
    "kg/m^3": (1.0, "kg"), "g/cm^3": (1e3, "kg"),
    "g/(mol*angstrom^3)": (_GRAM_PER_MOLE_PER_PARTICLE / _ANGSTROM**3, "kg"),
    "mol/m^3": (1.0, "mol"), "mol/L": (1e3, "mol"),
    "1/m^3": (1.0, "1"), "1/nm^3": (1e27, "1"), "1/angstrom^3": (1e30, "1"),
}
_MASS_FLUX = {
    "kg/(m^2*s)": (1.0, "kg"), "g/(cm^2*s)": (10.0, "kg"),
    "g/(mol*angstrom^2*ps)": (_GRAM_PER_MOLE_PER_PARTICLE / (_ANGSTROM**2 * 1e-12), "kg"),
    "g/(mol*angstrom^2*fs)": (_GRAM_PER_MOLE_PER_PARTICLE / (_ANGSTROM**2 * 1e-15), "kg"),
    "mol/(m^2*s)": (1.0, "mol"), "mol/(cm^2*s)": (1e4, "mol"),
    "1/(m^2*s)": (1.0, "1"),
    "1/(angstrom^2*ps)": (1e32, "1"), "1/(angstrom^2*fs)": (1e35, "1"),
}
_UNITS_ALIASES = {"A": "angstrom", "W/m2": "W/m^2", "kg/m3": "kg/m^3", "mol/m3": "mol/m^3",
                  "1/m3": "1/m^3", "atoms/m^3": "1/m^3", "atoms/angstrom^3": "1/angstrom^3",
                  "atoms/(m^2*s)": "1/(m^2*s)", "atoms/(angstrom^2*ps)": "1/(angstrom^2*ps)",
                  "atoms/(angstrom^2*fs)": "1/(angstrom^2*fs)"}
_ROLES = {"position", "field", "flux"}
_BOUNDS = ("position_min", "position_max", "time_min", "time_max", "bin_width")
_OPTIONS = {"mode", "columns", "units", "sheet", "source_job_id", "driving",
            "stress_convention", *_BOUNDS}


def _unit(value, role, choices):
    if isinstance(value, str):
        name = value.strip().replace("\u00c5", "angstrom").replace("\u00b2", "^2").replace("\u00b3", "^3")
        name = name.replace("/A^", "/angstrom^").replace("(A^", "(angstrom^")
        name = name.replace("*A^", "*angstrom^")
        if name == "A/ps" or name == "A/fs":
            name = "angstrom" + name[1:]
        name = _UNITS_ALIASES.get(name, name)
        if name in choices:
            return name
    raise ValueError(f"units.{role} must be one of {', '.join(choices)}")


def _law(mode, incoming, stress_convention):
    position = _unit(incoming["position"], "position", _POSITION)
    units = {"position": "m"}
    factors = {"position": _POSITION[position]}
    basis = None
    if mode == "conductivity":
        _unit(incoming["field"], "field", ("K",))
        flux = _unit(incoming["flux"], "flux", _HEAT_FLUX)
        units.update(field="K", flux="W/m^2", gradient="K/m", coefficient="W/(m*K)")
        factors.update(field=1.0, flux=_HEAT_FLUX[flux])
        sign, formula = -1, "k = -mean(q) / (dT/dx)"
    elif mode == "diffusivity":
        field = _unit(incoming["field"], "field", _CONCENTRATION)
        flux = _unit(incoming["flux"], "flux", _MASS_FLUX)
        field_scale, numerator = _CONCENTRATION[field]
        flux_scale, flux_numerator = _MASS_FLUX[flux]
        if numerator != flux_numerator:
            raise ValueError("Concentration and flux units must use the same mass, molar, or number basis")
        basis = {"kg": "mass", "mol": "molar", "1": "number"}[numerator]
        units.update(field=f"{numerator}/m^3", flux=f"{numerator}/(m^2*s)",
                     gradient=f"{numerator}/m^4", coefficient="m^2/s")
        factors.update(field=field_scale, flux=flux_scale)
        sign, formula = -1, "D = -mean(J) / (dc/dx)"
    else:
        field = _unit(incoming["field"], "field", _VELOCITY)
        flux = _unit(incoming["flux"], "flux", _STRESS)
        units.update(field="m/s", flux="Pa", gradient="1/s", coefficient="Pa*s")
        factors.update(field=_VELOCITY[field], flux=_STRESS[flux])
        if stress_convention == "momentum_flux":
            sign, formula = -1, "eta = -mean(P_xy) / (dv_x/dy)"
        else:
            sign, formula = 1, "eta = +mean(tau_xy) / (dv_x/dy)"
    return units, factors, basis, sign, formula


def _xlsx_rows(content, sheet):
    # Use the shared bounded worksheet parser. Read only the parts needed for
    # the selected sheet, without a separate pass over the ZIP entries.
    try:
        with ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if (len(entries) > 256 or len({entry.filename for entry in entries}) != len(entries)
                    or sum(entry.file_size for entry in entries) > 32 * 1024 * 1024
                    or any(entry.file_size > table.MAX_BYTES or entry.flag_bits & 1
                           or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED) for entry in entries)):
                raise ValueError("XLSX archive exceeds limits or has ambiguous or unsupported entries")
            root_rels = table._relationships(archive, "")
            workbook_part = table._target(table._by_kind(root_rels, "officeDocument"),
                                          "officeDocument", "")
            workbook, ns = table._xml(archive, workbook_part, "workbook", table.XLSX_NS)
            rels = table._relationships(archive, workbook_part)
            worksheets = {}
            for node in workbook.findall(f"{ns}sheets/{ns}sheet"):
                name = node.get("name")
                ids = [node.get(f"{{{uri}}}id") for uri in table.REL_NS if f"{{{uri}}}id" in node.attrib]
                if not name or len(ids) != 1 or ids[0] not in rels or name in worksheets:
                    raise ValueError("Invalid XLSX worksheet declaration")
                rel = rels[ids[0]]
                if rel.get("Type") in {f"{uri}/worksheet" for uri in table.REL_NS}:
                    worksheets[name] = rel
            if sheet is None:
                sheet = next(iter(worksheets), None)
            if sheet not in worksheets:
                raise ValueError(f"XLSX worksheet {sheet!r} not found. Available sheets: {', '.join(worksheets)}")
            part = table._target(worksheets[sheet], "worksheet", workbook_part)
            shared = []
            if reference := table._by_kind(rels, "sharedStrings"):
                strings, ns = table._xml(archive, table._target(reference, "sharedStrings", workbook_part),
                                         "sst", table.XLSX_NS)
                shared = [table._string(item, ns) for item in strings.findall(ns + "si")]
            return sheet, table._worksheet(archive, part, sheet, shared)
    except (BadZipFile, EOFError, NotImplementedError, OSError, zlib.error) as error:
        raise ValueError("Invalid or corrupt XLSX archive") from error


def _lammps_rows(content):
    block_format = None
    headers = None
    format_name = None
    rows = []
    remaining = 0
    cell_count = 0
    for line_no, raw in enumerate(io.StringIO(content.decode("utf-8-sig")), 1):
        text = raw.strip()
        if not text:
            continue
        if text.startswith("#"):
            fields = text[1:].split()
            if not fields:
                continue
            if fields[0].lower() == "timestep" and len(fields) > 1:
                if fields[1:] == ["Number-of-chunks", "Total-count"]:
                    block_format = (fields[0], "Chunk", 3, "lammps_ave_chunk")
                elif fields[1:] == ["Number-of-rows"]:
                    block_format = (fields[0], "Row", 2, "lammps_ave_time_vector")
                else:
                    format_name, current = "lammps_ave_time_scalar", fields
                    if headers is not None and headers != current:
                        raise ValueError(f"Line {line_no}: LAMMPS header changes within the file")
                    headers = current
            elif block_format and fields[0] == block_format[1]:
                current = [block_format[0], *fields]
                if headers is not None and headers != current:
                    raise ValueError(f"Line {line_no}: LAMMPS header changes within the file")
                headers = current
                format_name = block_format[3]
            continue
        if headers is None:
            raise ValueError("Expected CSV, XLSX, or a native LAMMPS fix ave/chunk or fix ave/time table "
                             "with named position, field and flux columns")
        fields = text.split()
        if block_format and remaining == 0:
            if len(fields) != block_format[2]:
                raise ValueError(f"Line {line_no}: invalid LAMMPS profile block header")
            timestep = fields[0]
            remaining = _integer(fields[1], f"line {line_no} row count")
            if len(rows) + remaining > table.MAX_ROWS:
                raise ValueError("LAMMPS profile exceeds row limit")
            continue
        if block_format:
            fields.insert(0, timestep)
            remaining -= 1
        if len(fields) != len(headers):
            raise ValueError(f"Line {line_no}: row width does not match LAMMPS column header")
        cell_count += len(fields)
        if (len(rows) >= table.MAX_ROWS or len(fields) > table.MAX_COLUMNS
                or cell_count > table.MAX_CELLS):
            raise ValueError("LAMMPS profile exceeds row, column or cell limits")
        rows.append((line_no, fields))
    if remaining:
        raise ValueError("Truncated LAMMPS profile block")
    if not rows:
        raise ValueError("No sampled rows in a supported LAMMPS profile")
    return format_name, None, headers, rows


def _read_source(filename, content, sheet):
    if not isinstance(filename, str) or not filename:
        raise ValueError("Expected a source filename")
    if not isinstance(content, bytes):
        raise ValueError("Upload must be bytes")
    suffix = filename.lower().rsplit(".", 1)[-1]
    if suffix == "csv":
        _, rows = table.read_table(filename, content, sheet)
    elif not 0 < len(content) <= table.MAX_BYTES:
        raise ValueError("Upload must be nonempty and at most 8 MiB")
    elif suffix == "xlsx":
        sheet, rows = _xlsx_rows(content, sheet)
    elif sheet is not None:
        raise ValueError("The sheet option applies only to XLSX files")
    else:
        try:
            return _lammps_rows(content)
        except UnicodeError as error:
            raise ValueError("Expected CSV, XLSX, or a UTF-8 LAMMPS profile table") from error
    if len(rows) < 2:
        raise ValueError("The table needs a header and sampled data rows")
    width = max(max(cells) for _, cells in rows) + 1
    if width * len(rows) > table.MAX_CELLS:
        raise ValueError("Source table exceeds the cell limit")
    _, header = rows[0]
    headers = [header.get(index) for index in range(width)]
    return suffix, sheet, headers, [
        (line_no, [cells.get(index) for index in range(width)])
        for line_no, cells in rows[1:]
    ]


def _window(options, roles):
    selection = {}
    for name in _BOUNDS:
        value = options.get(name)
        selection[name] = None if value is None else _number(value, name)
    if "time" not in roles and any(selection[name] is not None for name in ("time_min", "time_max")):
        raise ValueError("A time window requires an explicit time column and unit")
    for axis in ("position", "time"):
        start, end = selection[f"{axis}_min"], selection[f"{axis}_max"]
        if start is not None and end is not None and start > end:
            raise ValueError(f"{axis}_min must be at or below {axis}_max")
    if selection["bin_width"] is not None and selection["bin_width"] <= 0:
        raise ValueError("bin_width must be positive")
    return selection


def _in_window(value, low, high):
    return (low is None or low <= value) and (high is None or value <= high)


def _sample_rows(rows, indices, selection, factors):
    for line, values in rows:
        if selection["time_min"] is not None or selection["time_max"] is not None:
            time = _number(values[indices["time"]], f"line {line} time")
            if not _in_window(time, selection["time_min"], selection["time_max"]):
                continue
        position = _number(values[indices["position"]], f"line {line} position")
        if not _in_window(position, selection["position_min"], selection["position_max"]):
            continue
        field = _number(values[indices["field"]], f"line {line} field") * factors["field"]
        flux = _number(values[indices["flux"]], f"line {line} flux") * factors["flux"]
        yield position, field, flux


def _profile(samples, selection, length_scale):
    width = selection["bin_width"]
    origin = selection["position_min"]
    if width is not None:
        if origin is None:
            origin = min(sample[0] for sample in samples)
        bin_start, bin_width = Fraction(str(origin)), Fraction(str(width))
    bins = {}
    for sample in samples:
        position = sample[0]
        key = position if width is None else (Fraction(str(position)) - bin_start) // bin_width
        bins.setdefault(key, []).append(sample)
    profile = []
    for key in sorted(bins):
        positions, fields, fluxes = zip(*bins[key])
        profile.append({"position": fmean(positions) * length_scale, "field": fmean(fields),
                        "flux": fmean(fluxes), "count": len(positions)})
    selection.update(bin_origin=origin if width is not None else None,
                     bin_count=len(profile), selected_count=len(samples))
    return profile


def analyze_transport(filename: str, content: bytes, options: dict) -> dict:
    """Analyze one signed component of paired sampled transport data.

    Input windows and bin width use source units; the fitted profile and
    coefficient use SI. Source rows include every imported sample and original
    column, with physical source line numbers. The upload itself is unchanged.
    """
    if not isinstance(options, dict) or options.keys() - _OPTIONS:
        raise ValueError("Expected MD transport options: mode, columns, units, and optional selection/provenance")
    mode = options.get("mode")
    if mode not in ("conductivity", "diffusivity", "viscosity"):
        raise ValueError("mode must be conductivity, diffusivity, or viscosity")
    columns, incoming = options.get("columns"), options.get("units")
    if (not isinstance(columns, dict) or columns.keys() not in (_ROLES, _ROLES | {"time"})
            or any(not isinstance(name, str) or not name for name in columns.values())
            or len(set(columns.values())) != len(columns)):
        raise ValueError("Map distinct position, field, flux and optional time column names")
    if not isinstance(incoming, dict) or incoming.keys() != columns.keys():
        raise ValueError("Specify an input unit for each mapped column")
    if "time" in columns:
        _unit(incoming["time"], "time", _TIME)
    convention = options.get("stress_convention")
    if mode == "viscosity" and convention not in ("momentum_flux", "cauchy_stress"):
        raise ValueError("Viscosity requires stress_convention: momentum_flux (P_xy) or cauchy_stress (tau_xy)")
    if mode != "viscosity" and convention is not None:
        raise ValueError("stress_convention applies only to viscosity")
    driving = options.get("driving", "unspecified")
    if driving not in ("unspecified", "gradient_imposed", "flux_imposed"):
        raise ValueError("driving must be unspecified, gradient_imposed, or flux_imposed")
    sheet, source_job = options.get("sheet"), options.get("source_job_id")
    for name, value in (("sheet", sheet), ("source_job_id", source_job)):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError(f"{name} must be a nonempty string")
    selection = _window(options, columns)
    units, factors, basis, sign, formula = _law(mode, incoming, convention)
    file_format, sheet, headers, rows = _read_source(filename, content, sheet)
    indices = {}
    for role, name in columns.items():
        matches = [index for index, header in enumerate(headers) if header == name]
        if len(matches) != 1:
            raise ValueError(f"Column {name!r} for {role} must occur once in the source header")
        indices[role] = matches[0]

    samples = list(_sample_rows(rows, indices, selection, factors))
    if not samples:
        raise ValueError("No samples fall inside the selected position/time windows")
    try:
        profile = _profile(samples, selection, factors["position"])
        positions = [point["position"] for point in profile]
        fields = [point["field"] for point in profile]
        if len(set(positions)) < 2:
            raise ValueError("A spatial gradient requires at least two distinct occupied positions or bins")
        if not all(math.isfinite(value) for point in profile
                   for value in (point["position"], point["field"], point["flux"])):
            raise ValueError("Profile exceeds finite numeric range after conversion to SI")
        gradient, intercept = linear_regression(positions, fields)
        if gradient == 0:
            raise ValueError("The fitted spatial gradient is zero; the transport coefficient is undefined")
        mean_flux = fmean(sample[2] for sample in samples)
        coefficient = sign * mean_flux / gradient
        if not all(math.isfinite(value) for value in (gradient, intercept, mean_flux, coefficient)):
            raise ValueError("Transport result exceeds finite numeric range")
    except OverflowError as error:
        raise ValueError("Transport arithmetic exceeds finite numeric range") from error

    assumptions = [
        "The coordinate, field and signed flux or stress describe the same selected component and samples.",
        "Ordinary least squares fits field versus mean sampled position with an intercept and equal weight "
        "per occupied position or bin.",
        "Each selected source row contributes equally to mean flux or stress, including samples at repeated "
        "positions. Time selects rows and supplies no additional weight.",
        "The selected samples represent a linear transport regime. The input flux or stress is already "
        "intensive and normalized for the intended geometry and transport direction.",
        "The driving option records what the experiment imposed. The fit and mean use the observed "
        "columns in either case.",
    ]
    return {
        "kind": "md_transport", "mode": mode, "driving": driving,
        "concentration_basis": basis, "stress_convention": convention,
        "units": units, "selection": selection, "profile": profile,
        "gradient": gradient, "intercept": intercept, "mean_flux": mean_flux,
        "coefficient": coefficient, "coefficient_unit": units["coefficient"],
        "formula": formula, "assumptions": assumptions,
        "source": {"filename": filename, "format": file_format, "sheet": sheet, "source_job_id": source_job,
                   "headers": headers, "columns": dict(columns), "units": dict(incoming),
                   "rows": [{"line": line, "values": values} for line, values in rows]},
    }


def _join_velocity_source(profile, velocity, options):
    """Join one native profile and one native velocity table by sample keys."""
    columns = options.get("columns")
    if not isinstance(columns, dict) or not isinstance(columns.get("field"), str):
        raise ValueError("Paired transport sources require an explicit field column")
    sheet = options.get("sheet")
    _, _, profile_headers, profile_rows = _read_source(profile[0], profile[1], sheet)
    _, _, velocity_headers, velocity_rows = _read_source(velocity[0], velocity[1], sheet)
    field_name = columns["field"]
    field_source = options.get("field_source", "auto")
    if field_source not in ("auto", "profile", "velocity"):
        raise ValueError("field_source must be auto, profile, or velocity")
    if field_source != "velocity" and field_name in profile_headers:
        return profile[0], profile[1]
    if field_name not in velocity_headers:
        raise ValueError(f"Column {field_name!r} for field is absent from profile and velocity sources")
    if field_source == "profile":
        raise ValueError(f"Column {field_name!r} for field is absent from the profile source")

    key_names = []
    for name in ("Timestep", "Chunk", columns.get("time"), columns.get("position"), "Ncount"):
        if name and name in profile_headers and name in velocity_headers and name not in key_names:
            key_names.append(name)
    if not key_names:
        raise ValueError("Profile and velocity sources have no shared sample keys")
    profile_index = {name: index for index, name in enumerate(profile_headers)}
    velocity_index = {name: index for index, name in enumerate(velocity_headers)}
    field_index = velocity_index[field_name]
    joined = {}
    for _, row in velocity_rows:
        key = tuple(row[velocity_index[name]] for name in key_names)
        if key in joined:
            raise ValueError("Velocity source has duplicate rows for a profile sample")
        joined[key] = row[field_index]
    rows = []
    for _, row in profile_rows:
        key = tuple(row[profile_index[name]] for name in key_names)
        if key not in joined:
            raise ValueError("Velocity source is missing a profile sample")
        rows.append([*row, joined[key]])
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow([*profile_headers, field_name])
    writer.writerows(rows)
    return "transport_profile_velocity.csv", output.getvalue().encode("utf-8")


def analyze_transport_sources(sources: dict, options: dict) -> dict:
    """Analyze an explicit role map of transport raw sources.

    The role map is intentionally fixed: ``profile`` is the primary spatial
    table, ``velocity`` is an optional paired table, and ``global_flux`` /
    ``metadata`` / ``provenance`` are retained by the caller as provenance.
    A velocity field is joined to the profile by native timestep/chunk/
    position/count keys before the existing single-table analyzer runs.
    """
    if not isinstance(sources, dict):
        raise ValueError("Transport sources must be a role map")
    primary = sources.get("profile") or sources.get("global_flux")
    if not isinstance(primary, tuple) or len(primary) < 2:
        raise ValueError("Transport sources require a profile or global_flux table")
    analysis_options = dict(options)
    field_source = analysis_options.get("field_source", "auto")
    analysis_options.pop("field_source", None)
    velocity = sources.get("velocity")
    if isinstance(velocity, tuple) and primary is sources.get("profile"):
        field_name = analysis_options.get("columns", {}).get("field")
        profile_headers = _read_source(primary[0], primary[1], analysis_options.get("sheet"))[2]
        if field_source == "velocity" or field_name not in profile_headers:
            joined_name, joined_content = _join_velocity_source(primary, velocity, options)
            return analyze_transport(joined_name, joined_content, analysis_options)
    return analyze_transport(primary[0], primary[1], analysis_options)
