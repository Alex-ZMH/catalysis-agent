"""Bounded ZIP ingestion for the v1 adsorption workflow."""

import io
import json
import math
import re
import stat
import zipfile
import zlib
from collections import Counter
from fractions import Fraction
from os import getenv
from xml.etree import ElementTree as ET

from . import adsorption

_AXES = ("a", "b", "c")


def _budget(name, default):
    key = f"CATALYSIS_VASP_{name}"
    value = getenv(key, str(default))
    if not re.fullmatch("[1-9][0-9]{0,8}", value):
        raise ValueError(f"{key} must be a positive integer (up to nine digits)")
    return int(value)


class _Tree(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = self.nodes = 0
        self.max_nodes = _budget("XML_NODES", 2_000_000)
        self.root = self.last_step = None
        self.steps = 0

    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > 64:
            raise ValueError("XML exceeds maximum depth of 64")
        if self.nodes > self.max_nodes:
            raise ValueError(f"XML exceeds CATALYSIS_VASP_XML_NODES={self.max_nodes}")
        node = super().start(tag, attrs)
        if self.depth == 1:
            self.root = node
        return node

    def end(self, tag):
        node = super().end(tag)
        if self.depth == 2 and tag == "calculation":
            if self.last_step is not None:
                self.root.remove(self.last_step)
            self.last_step = node
            self.steps += 1
        self.depth -= 1
        return node

    def doctype(self, *_):
        raise ValueError("XML DTDs and entities are forbidden")


def _members(content):
    upload, member, total = (_budget(key, default) for key, default in
                             (("ZIP_MIB", 64), ("MEMBER_MIB", 128), ("TOTAL_MIB", 256)))
    mib = 1024**2
    if not isinstance(content, bytes) or len(content) > upload * mib:
        raise ValueError(f"ZIP upload must be bytes, at most CATALYSIS_VASP_ZIP_MIB={upload} MiB")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        entries = archive.infolist()
        if len(entries) > 128 or sum(item.file_size for item in entries) > total * mib:
            raise ValueError(f"ZIP exceeds 128 entries or CATALYSIS_VASP_TOTAL_MIB={total} MiB expanded")
        files = {}
        paths = set()
        for item in entries:
            name = item.orig_filename.rstrip("/")
            if (len(name) > 240 or any(part in ("", ".", "..") for part in name.split("/"))
                    or any(ord(char) < 32 or char in "\\:" for char in name)
                    or name.casefold() in paths
                    or stat.S_ISLNK(item.external_attr >> 16)
                    or item.flag_bits & 1
                    or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise ValueError(f"Unsupported or unsafe ZIP entry: {name!r}")
            paths.add(name.casefold())
            if item.file_size > member * mib:
                raise ValueError(f"{name} exceeds CATALYSIS_VASP_MEMBER_MIB={member} MiB")
            if not item.is_dir():
                with archive.open(item) as source:
                    data = source.read(item.file_size + 1)
                if len(data) != item.file_size:
                    raise ValueError(f"ZIP member size mismatch: {name}")
                files[name] = data
        return files


def _object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate key in study.json")
    return result


def _number(value):
    if isinstance(value, bool):
        raise ValueError("Expected a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Expected a finite number")
    return number


def _integer(value):
    return int(value)


def _fields(elements):
    return {node.attrib["name"]: (node.text or "").strip()
            for node in elements if "name" in node.attrib}


def _flag(text):
    if text.upper() in ("T", "TRUE", ".TRUE."):
        return True
    if text.upper() in ("F", "FALSE", ".FALSE."):
        return False
    raise ValueError(f"Invalid VASP logical value {text!r}")


def _rows(node, path, convert=_number):
    rows = [[convert(value) for value in (row.text or "").split()]
            for row in node.findall(path)]
    if not rows or any(len(row) != 3 for row in rows):
        raise ValueError(f"Expected three-component rows at {path}")
    return rows


def _method(params, types, state):
    def enabled(key):
        return _flag(params[key])

    spin = _integer(params["ISPIN"])
    if spin not in (1, 2):
        raise ValueError("ISPIN must be 1 or 2")
    soc = enabled("LSORBIT")
    mode = ("noncollinear" if enabled("LNONCOLLINEAR") or soc
            else "collinear" if spin == 2 else "nonmagnetic")
    potential_ids = {}
    neutral_electrons = Fraction()
    for count, symbol, _, valence, title in types:
        if symbol in potential_ids:
            raise ValueError(f"v1 cannot represent multiple POTCAR types for {symbol}")
        potential_ids[symbol] = title
        neutral_electrons += _integer(count) * Fraction(str(_number(valence)))
    functional = [f"GGA={params['GGA'].upper()}", f"METAGGA={params['METAGGA'].upper()}"]
    if enabled("LHFCALC"):
        functional.extend(f"{key}={_number(params[key])}" for key in
                          ("AEXX", "HFSCREEN", "AGGAX", "AGGAC", "ALDAC"))
    if "LEXCH" in params:
        functional.append(f"LEXCH={params['LEXCH'].upper()}")
    dispersion = [f"IVDW={_integer(params['IVDW'])}"]
    if "LUSE_VDW" in params:
        dispersion.append(f"LUSE_VDW={enabled('LUSE_VDW')}")
    for key in ("VDW_VERSION", "VDW_S6", "VDW_S8", "VDW_SR", "VDW_SR6", "VDW_SR8",
                "VDW_A1", "VDW_A2", "PARAM1", "PARAM2", "BPARAM", "CPARAM", "ZAB_VDW"):
        if key in params:
            dispersion.append(f"{key}={_number(params[key])}")
    hubbard = {}
    if enabled("LDAU"):
        if _integer(params["LDAUTYPE"]) != 2:
            raise ValueError("v1 supports Dudarev DFT+U (LDAUTYPE=2)")
        angular = list(map(int, params["LDAUL"].split()))
        u_values = list(map(_number, params["LDAUU"].split()))
        j_values = list(map(_number, params["LDAUJ"].split()))
        if not len(angular) == len(u_values) == len(j_values) == len(types):
            raise ValueError("DFT+U arrays must match atomtypes")
        for (_, symbol, *_), orbital, u, j in zip(types, angular, u_values, j_values):
            if orbital >= 0:
                hubbard[symbol] = u - j
    return {
        "functional": " ".join(functional),
        "pseudopotential_ids": potential_ids,
        "cutoff_eV": _number(params["ENCUT"]),
        "hubbard_U_eV": hubbard,
        "dispersion": " ".join(dispersion),
        "occupation_scheme": f"ISMEAR={_integer(params['ISMEAR'])}",
        "smearing_eV": _number(params["SIGMA"]),
        "charge_e": float(neutral_electrons - Fraction(str(_number(params["NELECT"])))),
        "magnetism": {"mode": mode, "spin_orbit": soc, "state": state},
    }


def _max_free_force(forces, masks, basis):
    maximum = 0.0
    for force, mask in zip(forces, masks, strict=True):
        orthonormal = []
        for vector, free in zip(basis, mask):
            if free:
                remainder = list(vector)
                for axis in orthonormal:
                    projection = sum(a * b for a, b in zip(remainder, axis))
                    remainder = [a - projection * b for a, b in zip(remainder, axis)]
                norm = math.hypot(*remainder)
                if norm <= 1e-10:
                    raise ValueError("Degenerate free Cartesian subspace")
                orthonormal.append([value / norm for value in remainder])
        maximum = max(maximum, math.hypot(*(sum(a * b for a, b in zip(force, axis))
                                           for axis in orthonormal)))
    return maximum


def _parse(data, run):
    tree = _Tree()
    root = ET.fromstring(data, parser=ET.XMLParser(target=tree))
    if root.tag != "modeling":
        raise ValueError("Expected VASP modeling root")
    xml_params = _fields(root.findall("./incar/*")) | {
        key: value for key, value in _fields(root.findall("./parameters//*")).items() if value}
    params = dict(xml_params)
    defaults = {"METAGGA": "--", "LSORBIT": "F", "LNONCOLLINEAR": "F", "ISPIN": "1",
                "LHFCALC": "F", "LDAU": "F", "IVDW": "0", "LUSE_VDW": "F",
                "ISMEAR": "1", "SIGMA": "0.2"}
    for key, value in defaults.items():
        if not params.get(key):
            params[key] = value
    supplied = run.get("missing_parameters", {})
    if not isinstance(supplied, dict):
        raise ValueError("missing_parameters must be an object")
    allowed = {"GGA", "METAGGA", "LSORBIT", "LNONCOLLINEAR", "ISPIN", "LHFCALC",
               "LDAU", "IVDW", "LUSE_VDW", "ISMEAR", "SIGMA", "EDIFFG",
               "ENCUT", "NELECT", "EDIFF", "NELM", "NSW", "IBRION"}
    for key, value in supplied.items():
        if key not in allowed or xml_params.get(key) or not isinstance(value, str) or not value.strip():
            raise ValueError(f"missing_parameters.{key} cannot override XML or supply an unsupported value")
        params[key] = value.strip()
    if run["geometry_history"] not in ("relaxation", "restart_from_relaxed"):
        raise ValueError("geometry_history must describe relaxation or a documented relaxed restart")
    if (run["geometry_history"] == "relaxation"
            and (_integer(params["NSW"]) <= 0 or _integer(params["IBRION"]) not in (1, 2, 3))):
        raise ValueError("Static XML requires restart_from_relaxed and prior relaxation evidence")
    generation = root.find("./kpoints/generation")
    if generation is None or generation.get("param") not in ("Gamma", "Monkhorst-Pack"):
        raise ValueError("v1 requires a generated Gamma or Monkhorst-Pack k-grid")
    grid, = _rows(generation, "./v[@name='divisions']", _integer)
    shift = generation.findtext("./v[@name='usershift']", "0 0 0").split()
    if len(shift) != 3 or any(_number(value) for value in shift):
        raise ValueError("v1 requires a k-grid without a custom shift")

    elements = []
    type_indices = []
    for atom in root.findall("./atominfo/array[@name='atoms']/set/rc"):
        symbol, type_index = [(field.text or "").strip() for field in atom.findall("./c")]
        elements.append(symbol)
        type_indices.append(_integer(type_index))
    types = [[(field.text or "").strip() for field in item.findall("./c")]
             for item in root.findall("./atominfo/array[@name='atomtypes']/set/rc")]
    if (not elements or not types or any(len(row) != 5 for row in types)
            or any(index < 1 or index > len(types) or types[index - 1][1] != symbol
                   for symbol, index in zip(elements, type_indices))
            or Counter(type_indices) != Counter({idx: _integer(row[0])
                                                 for idx, row in enumerate(types, 1)})):
        raise ValueError("VASP atoms and atomtypes disagree")

    steps = root.findall("./calculation")
    if not steps:
        raise ValueError("No ionic calculation step found")
    final = steps[-1]
    structure = final.find("./structure")
    if structure is None:
        raise ValueError("Final calculation has no associated structure")
    basis = _rows(structure, "./crystal/varray[@name='basis']/v")
    positions = _rows(structure, "./varray[@name='positions']/v")
    forces = _rows(final, "./varray[@name='forces']/v")
    if not len(positions) == len(elements) == len(forces):
        raise ValueError("Final positions, forces and atominfo counts disagree")
    masks = structure.findall("./varray[@name='selective']/v")
    mask_source = "final calculation structure"
    if not masks:
        masks = root.findall("./structure[@name='initialpos']/varray[@name='selective']/v")
        mask_source = "initialpos (fixed selective-dynamics flags)"
    if masks:
        masks = [[_flag(token) for token in (row.text or "").split()] for row in masks]
    else:
        masks = run["free_directions"]
        mask_source = "protocol evidence"
        if masks == "all":
            masks = [[True, True, True]] * len(elements)
    if (not isinstance(masks, list) or len(masks) != len(elements)
            or any(not isinstance(row, list) or len(row) != 3
                   or any(type(flag) is not bool for flag in row) for row in masks)):
        raise ValueError("Expected one boolean selective-dynamics triplet per atom")

    sc_steps = [_fields(step.findall("./energy/i")) for step in final.findall("./scstep")]
    electronic_limit = _number(params["EDIFF"])
    if electronic_limit <= 0:
        raise ValueError("EDIFF must be positive to assess SCF convergence")
    scf_fields = ("e_fr_energy", "e_wo_entrp")
    has_scf_proxy = len(sc_steps) >= 2 and all(
        step.get(key) for step in sc_steps[-2:] for key in scf_fields)
    if has_scf_proxy:
        residual = max(abs(_number(sc_steps[-1][key]) - _number(sc_steps[-2][key]))
                       for key in scf_fields)
    else:
        if "scf_residual_eV" not in run:
            raise ValueError("Final SCF steps lack named free/without-entropy energies; "
                             "provide scf_residual_eV from full-precision protocol evidence")
        residual = _number(run["scf_residual_eV"])
        if residual < 0:
            raise ValueError("Supplementary SCF residual must be nonnegative")
    if len(sc_steps) >= _integer(params["NELM"]) and residual <= electronic_limit:
        raise ValueError("SCF reached NELM with ambiguous convergence at XML precision")
    force_threshold = _number(params["EDIFFG"])
    force_limit = -force_threshold if force_threshold < 0 else _number(
        run["force_limit_eV_per_angstrom"])
    normalized = {
        "structure_id": run["structure_id"],
        "composition": dict(Counter(elements)),
        "energy_eV": _number(_fields(final.findall("./energy/i"))["e_fr_energy"]),
        "method": _method(params, types, run["magnetic_state"]),
        "k_grid": grid,
        "k_grid_centering": "gamma" if generation.get("param") == "Gamma" else "monkhorst_pack",
        "convergence": {
            "scf_residual_eV": residual,
            "scf_limit_eV": electronic_limit,
            "max_free_force_eV_per_angstrom": _max_free_force(forces, masks, basis),
            "force_limit_eV_per_angstrom": force_limit,
            "evidence_id": run["structure_id"],
        },
    }
    if not isinstance(run["magnetic_state"], str) or not run["magnetic_state"].strip():
        raise ValueError("magnetic_state must be a nonempty description")
    return normalized, {
        "basis_A": basis, "fractional_positions": positions, "elements": elements,
        "energy_eV": normalized["energy_eV"],
        "free_directions": masks, "free_directions_source": mask_source,
        "ionic_steps": tree.steps, "scf_steps": len(sc_steps),
        "scf_residual_source": "XML rounded delta proxy" if has_scf_proxy else "protocol evidence",
        "convergence_uses_supplement": (
            not has_scf_proxy or mask_source == "protocol evidence" or force_threshold >= 0
            or bool(supplied.keys() & {"EDIFF", "EDIFFG", "NELM"})),
        "geometry_history": run["geometry_history"], "supplementary_parameters": supplied,
        "NELM": _integer(params["NELM"]), "EDIFFG": force_threshold,
        "vasp_version": root.findtext("./generator/i[@name='version']"),
    }


_ROLE_FIELDS = {
    "bulk": (),
    "clean_slab": ("bulk_structure_id", "bulk_to_slab_atom_map_id", "miller_indices",
                   "termination", "fixed_layers_id", "slab_thickness_angstrom",
                   "vacuum_angstrom", "finite_size_check"),
    "configurations": ("clean_structure_id", "clean_to_adsorbed_atom_map_id",
                       "fixed_layers_id", "vacuum_angstrom", "adsorbed_units",
                       "reference_coefficients"),
    "gas_references": ("isolation_check",),
}


def _evidence_ids(run, role):
    yield run["protocol_evidence_id"]
    if run["geometry_history"] == "restart_from_relaxed":
        yield run["prior_relaxation_evidence_id"]
    if role == "clean_slab":
        yield run["bulk_to_slab_atom_map_id"]
        yield run["fixed_layers_id"]
        yield run["finite_size_check"]["evidence_id"]
    if role == "configurations":
        yield run["clean_to_adsorbed_atom_map_id"]
        yield run["fixed_layers_id"]
    if role == "gas_references":
        yield run["isolation_check"]["evidence_id"]


def _remap(run, structures, evidence, details):
    for key in ("structure_id", "bulk_structure_id", "clean_structure_id"):
        if key in run:
            run[key] = structures[run[key]]
    for key in ("bulk_to_slab_atom_map_id", "clean_to_adsorbed_atom_map_id", "fixed_layers_id"):
        if key in run:
            run[key] = evidence[run[key]]
    run["convergence"]["evidence_id"] = (
        evidence[details["protocol_evidence_id"]] if details["convergence_uses_supplement"]
        else run["structure_id"])
    for key in ("finite_size_check", "isolation_check"):
        if key in run:
            run[key]["evidence_id"] = evidence[run[key]["evidence_id"]]
    if "reference_coefficients" in run:
        run["reference_coefficients"] = {
            structures[key]: value for key, value in run["reference_coefficients"].items()
        }


def analyze(filename: str, content: bytes, options: dict, origin: str,
            raw_id: str, register: callable) -> tuple[dict, dict, dict]:
    """Import a study, validate v1 payloads and register exact source members."""
    from .cell import check_cell

    if origin not in ("synthetic", "research"):
        raise ValueError("origin must be synthetic or research")
    if not isinstance(filename, str) or not filename.lower().endswith(".zip"):
        raise ValueError("Upload a .zip containing study.json and per-run vasprun.xml files")
    if not isinstance(options, dict) or options.keys() - {"cell_limits_A"}:
        raise ValueError("Supported ZIP option: cell_limits_A")
    limits = options.get("cell_limits_A", [50, 50, 50])
    if isinstance(limits, list) and len(limits) == 3:
        limits = dict(zip(_AXES, limits))
    if (not isinstance(limits, dict) or limits.keys() - set(_AXES)
            or any(type(value) not in (int, float) or not 0 < value <= 50
                   for value in limits.values())):
        raise ValueError("cell_limits_A must specify positive a/b/c limits, each at most 50 Å")
    try:
        members = _members(content)
    except (zipfile.BadZipFile, RuntimeError, EOFError, OSError, zlib.error, NotImplementedError) as exc:
        raise ValueError(f"Invalid ZIP: {exc}") from exc
    try:
        manifest = members["study.json"]
        if len(manifest) > 256 * 1024:
            raise ValueError("study.json exceeds 256 KiB")
        study = json.loads(manifest.decode("utf-8-sig"), object_pairs_hook=_object)
        sources = study["evidence"]
        if not isinstance(sources, dict) or any(
            not re.fullmatch("[A-Za-z0-9][A-Za-z0-9_-]{0,127}", key)
            or not isinstance(path, str) or path == "study.json"
            or path not in members or not members[path].strip()
            or path.lower().endswith("vasprun.xml")
            for key, path in sources.items()
        ):
            raise ValueError("evidence must map valid evidence IDs to nonempty supplementary files")
        if len(set(sources.values())) != len(sources):
            raise ValueError("Each evidence ID must point to a distinct ZIP member")
        for role, minimum in (("configurations", 2), ("gas_references", 1)):
            if not isinstance(study[role], list) or len(study[role]) < minimum:
                raise ValueError(f"{role} must contain at least {minimum} runs")
        normalized = {"energy_unit": "eV", "adsorbate_formula": study["adsorbate_formula"]}
        rows = normalized["configurations"] = []
        gas = normalized["gas_references"] = []
        runs = [("bulk", study["bulk"]), ("clean_slab", study["clean_slab"])]
        runs.extend(("configurations", run) for run in study["configurations"])
        runs.extend(("gas_references", run) for run in study["gas_references"])
    except (KeyError, TypeError, RecursionError, UnicodeError, AttributeError) as exc:
        raise ValueError(f"Invalid study.json: {exc}") from exc

    details = []
    used_xml = set()
    for role, run in runs:
        path = "?"
        try:
            path = run["file"]
            if (not isinstance(path, str) or path.split("/")[-1] != "vasprun.xml"
                    or path in used_xml or path not in members):
                raise ValueError("Each run needs a unique member named vasprun.xml")
            used_xml.add(path)
            for key in _evidence_ids(run, role):
                if key not in sources:
                    raise ValueError(f"Undeclared supplementary evidence ID {key!r}")
            parsed, geometry = _parse(members[path], run)
            cell = check_cell(geometry["basis_A"], limits)
            parsed.update({key: run[key] for key in _ROLE_FIELDS[role]})
            if role == "bulk":
                parsed["vacuum_angstrom"] = 0
            if role == "gas_references":
                parsed["box_lengths_angstrom"] = [cell["lengths_A"][axis] for axis in _AXES]
            if run.get("site") is not None and not isinstance(run["site"], str):
                raise ValueError("site must be a string")
            details.append(dict(geometry, role=role, file=path, cell_check=cell,
                                structure_id=parsed["structure_id"],
                                protocol_evidence_id=run["protocol_evidence_id"],
                                prior_relaxation_evidence_id=run.get("prior_relaxation_evidence_id"),
                                site=run.get("site")))
            if role == "configurations":
                rows.append(parsed)
            elif role == "gas_references":
                gas.append(parsed)
            else:
                normalized[role] = parsed
        except (ET.ParseError, KeyError, TypeError, ValueError, OverflowError, AttributeError, LookupError) as exc:
            raise ValueError(f"{role} ({path}): {exc}") from exc

    oversized = [f"{row['structure_id']}: lengths_A={row['cell_check']['lengths_A']}, "
                 f"limits_A={row['cell_check']['limits_A']}, "
                 f"exceeded_axes={row['cell_check']['exceeded_axes']}"
                 for row in details if not row["cell_check"]["within_limit"]]
    if oversized:
        raise ValueError("VASP cell exceeds size limits in Å: " + "; ".join(oversized))

    clean_basis = details[1]["basis_A"]
    for row in details:
        if row["role"] == "configurations" and any(
            not math.isclose(expected, actual, rel_tol=0, abs_tol=1e-6)
            for clean_vector, config_vector in zip(clean_basis, row["basis_A"])
            for expected, actual in zip(clean_vector, config_vector)
        ):
            raise ValueError(f"{row['structure_id']} ({row['file']}): fixed-cell comparison "
                             "requires the same ordered lattice vectors as the clean slab "
                             f"(1e-6 Å component tolerance); got {row['basis_A']}, clean={clean_basis}")

    adsorption.validate_input(normalized)
    ids = {path: register(path, members[path])
           for path in sorted({"study.json", *used_xml, *sources.values()})}
    structures = {row["structure_id"]: ids[row["file"]] for row in details}
    evidence = {key: ids[path] for key, path in sources.items()}
    for run, detail in zip((normalized["bulk"], normalized["clean_slab"], *rows, *gas),
                           details, strict=True):
        _remap(run, structures, evidence, detail)
    result = adsorption.derive_result(normalized)
    adsorption.validate_result(result, normalized)
    ranked = sorted((row for row in result["results"] if row["status"] == "comparable"),
                    key=lambda row: row["adsorption_energy"])
    for row in details:
        row.update(logical_id=row["structure_id"], structure_id=ids[row["file"]],
                   blob_id=ids[row["file"]], parent_raw_id=raw_id)
    return normalized, result, {
        "origin": origin, "raw_id": raw_id, "filename": filename,
        "manifest_blob_id": ids["study.json"], "energy_field": "e_fr_energy",
        "runs": details, "ranking": [row["structure_id"] for row in ranked],
        "evidence": {key: {"file": path, "blob_id": ids[path], "parent_raw_id": raw_id}
                     for key, path in sources.items()},
    }
