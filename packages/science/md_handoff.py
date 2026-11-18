"""Convert a VASP structure to LAMMPS data without running either engine."""
from collections import Counter
from math import floor, fsum, hypot
import re
from xml.etree import ElementTree as ET

from .cell import _cross, _dot, _geometry, _number
from .vasp import _flag, _rows


# Conventional atomic weights (g/mol) for elements with standard weights.
# Explicit overrides also cover isotopes, pseudopotential labels and other species.
_MASSES = dict(zip(
    ("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn "
     "Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr "
     "Nd Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Th Pa U").split(),
    (1.008, 4.002602, 6.94, 9.0121831, 10.81, 12.011, 14.007, 15.999, 18.998403163, 20.1797,
     22.98976928, 24.305, 26.9815385, 28.085, 30.973761998, 32.06, 35.45, 39.948, 39.0983,
     40.078, 44.955908, 47.867, 50.9415, 51.9961, 54.938044, 55.845, 58.933194, 58.6934,
     63.546, 65.38, 69.723, 72.630, 74.921595, 78.971, 79.904, 83.798, 85.4678, 87.62,
     88.90584, 91.224, 92.90637, 95.95, 101.07, 102.90550, 106.42, 107.8682, 112.414,
     114.818, 118.710, 121.760, 127.60, 126.90447, 131.293, 132.90545196, 137.327, 138.90547,
     140.116, 140.90766, 144.242, 150.36, 151.964, 157.25, 158.92535, 162.500, 164.93033,
     167.259, 168.93422, 173.045, 174.9668, 178.49, 180.94788, 183.84, 186.207, 190.23,
     192.217, 195.084, 196.966569, 200.592, 204.38, 207.2, 208.98040, 232.0377, 231.03588,
     238.02891),
    strict=True,
))
_LABEL = re.compile(r"[A-Za-z][A-Za-z0-9_+-]{0,31}")
_COUNT = re.compile(r"[0-9]+")
_INPUT_LIMIT = 128 * 1024**2


def _right_handed(units):
    determinant = _dot(_cross(*units[:2]), units[2])
    if determinant <= 0:
        raise ValueError("Expected a right-handed VASP cell")
    return determinant


def _mode(line):
    marker = line[0].lower() if line else ""
    if marker in {"d", "direct"}:
        return "direct"
    if marker in {"c", "cart", "cartesian", "k", "kartesian"}:
        return "cartesian"
    raise ValueError("Expected Direct or Cartesian POSCAR coordinates")


def _poscar(data, supplied_species):
    raw = data.decode("utf-8-sig").splitlines()
    lines = [line.partition("!")[0].split() for line in raw[1:]]
    if len(lines) < 7 or len(lines[0]) not in (1, 3):
        raise ValueError("Invalid POSCAR header or scale factors")
    basis, lengths, units = _geometry(lines[1:4])
    determinant = _right_handed(units)
    scales = [_number(value) for value in lines[0]]
    if len(scales) == 1:
        scale = scales[0]
        if scale < 0:
            # A negative single scale specifies the positive final volume in A^3.
            scale = ((-scale) ** (1 / 3) / determinant ** (1 / 3)
                     / lengths[0] ** (1 / 3) / lengths[1] ** (1 / 3) / lengths[2] ** (1 / 3))
        scales = [scale] * 3
    if min(scales) <= 0:
        raise ValueError("Invalid POSCAR scale factors")
    basis, lengths, units = _geometry([[x * s for x, s in zip(row, scales)] for row in basis])

    if lines[4] and all(_COUNT.fullmatch(token) for token in lines[4]):
        if supplied_species is None:
            raise ValueError("POSCAR has no species labels; supply options.species in count order")
        labels, count_line = supplied_species, 4
    else:
        if supplied_species is not None:
            raise ValueError("options.species is only for POSCAR files without species labels")
        labels, count_line = lines[4], 5
    counts = lines[count_line]
    if (not labels or len(counts) != len(labels)
            or any(not _COUNT.fullmatch(token) for token in counts)):
        raise ValueError("Expected one atom count per POSCAR species")
    counts = [int(token) for token in counts]
    mode_line = count_line + 1
    selective = bool(lines[mode_line] and lines[mode_line][0].lower().startswith("s"))
    mode_line += selective
    if mode_line >= len(lines):
        raise ValueError("Missing POSCAR coordinate mode")
    mode = _mode(lines[mode_line])
    count = sum(counts)
    atom_rows = lines[mode_line + 1:mode_line + 1 + count]
    if not count or len(atom_rows) != count:
        raise ValueError("POSCAR atom count does not match positions")
    tail = lines[mode_line + 1 + count:]
    if tail and tail[0]:
        # A CONTCAR velocity or lattice velocity block can follow the geometry.
        if [token.lower() for token in tail[0]] != ["lattice", "velocities", "and", "vectors"]:
            _mode(tail[0])

    duals = [_cross(units[(i + 1) % 3], units[(i + 2) % 3]) for i in range(3)]
    positions, masks = [], []
    for row in atom_rows:
        if len(row) != (6 if selective else 3):
            raise ValueError("Invalid POSCAR atom row")
        xyz = tuple(_number(token) for token in row[:3])
        if mode == "cartesian":
            xyz = tuple(_number(x * s) for x, s in zip(xyz, scales))
            xyz = tuple(_number(_dot(xyz, dual) / length / _dot(unit, dual))
                        for dual, length, unit in zip(duals, lengths, units))
        positions.append(xyz)
        if selective:
            if any(flag.upper() not in {"T", "F"} for flag in row[3:]):
                raise ValueError("Invalid POSCAR selective dynamics flags")
            masks.append([flag.upper() == "T" for flag in row[3:]])
    atom_types = [idx for idx, count in enumerate(counts, 1) for _ in range(count)]
    return basis, labels, atom_types, positions, masks


class _StructureTree(ET.TreeBuilder):
    """Keep only the root-level atominfo and finalpos records."""
    def __init__(self):
        super().__init__()
        self.root = None
        self.depth = self.nodes = 0

    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > 64 or self.nodes > 2_000_000:
            raise ValueError("VASP XML exceeds the structure parser limits")
        node = super().start(tag, attrs)
        if self.depth == 1:
            self.root = node
        return node

    def end(self, tag):
        node = super().end(tag)
        if self.depth == 2 and tag != "atominfo" and (
            tag != "structure" or node.get("name") != "finalpos"
        ):
            self.root.remove(node)
        self.depth -= 1
        return node

    def doctype(self, *_):
        raise ValueError("XML DTDs and entities are forbidden")


def _vasprun(data):
    try:
        root = ET.fromstring(data, parser=ET.XMLParser(target=_StructureTree()))
    except ET.ParseError as error:
        raise ValueError("Invalid vasprun.xml") from error
    structures = root.findall("./structure[@name='finalpos']")
    infos = root.findall("./atominfo")
    if root.tag != "modeling" or len(structures) != 1 or len(infos) != 1:
        raise ValueError("Expected one VASP finalpos structure and atominfo")
    final = structures[0]
    basis = _rows(final, "./crystal/varray[@name='basis']/v")
    positions = _rows(final, "./varray[@name='positions']/v")
    species_by_id, atom_types = {}, []
    for atom in infos[0].findall("./array[@name='atoms']/set/rc"):
        fields = [(field.text or "").strip() for field in atom.findall("./c")]
        if len(fields) != 2 or not _COUNT.fullmatch(fields[1]):
            raise ValueError("Invalid VASP atominfo row")
        label, type_id = fields[0], int(fields[1])
        if species_by_id.setdefault(type_id, label) != label:
            raise ValueError("VASP atom labels disagree within a type")
        atom_types.append(type_id)
    if (len(atom_types) != len(positions)
            or species_by_id.keys() != set(range(1, len(species_by_id) + 1))):
        raise ValueError("VASP final positions and atominfo counts or types disagree")
    labels = [species_by_id[type_id] for type_id in range(1, len(species_by_id) + 1)]
    types = infos[0].findall("./array[@name='atomtypes']/set/rc")
    if types:
        counts = Counter(atom_types)
        if len(types) != len(labels):
            raise ValueError("VASP atomtypes and atoms disagree")
        for type_id, (row, label) in enumerate(zip(types, labels), 1):
            fields = [(field.text or "").strip() for field in row.findall("./c")]
            if (len(fields) < 2 or not _COUNT.fullmatch(fields[0])
                    or (int(fields[0]), fields[1]) != (counts[type_id], label)):
                raise ValueError("VASP atomtypes and atoms disagree")
    masks = [[_flag(value) for value in (row.text or "").split()]
             for row in final.findall("./varray[@name='selective']/v")]
    if masks and (len(masks) != len(positions) or any(len(mask) != 3 for mask in masks)):
        raise ValueError("VASP selective dynamics flags and positions disagree")
    return basis, labels, atom_types, positions, masks


def _restricted(basis):
    rows, lengths, units = _geometry(basis)
    _right_handed(units)
    a = units[0]
    normal = _cross(*units[:2])
    normal_length = hypot(*normal)
    z = tuple(v / normal_length for v in normal)
    y = _cross(z, a)
    restricted = [(lengths[0], 0.0, 0.0),
                  (_dot(rows[1], a), lengths[1] * normal_length, 0.0),
                  (_dot(rows[2], a), _dot(rows[2], y), _dot(rows[2], z))]
    restricted = [tuple(_number(x) for x in row) for row in restricted]
    if any(row[i] <= 0 for i, row in enumerate(restricted)):
        raise ValueError("Restricted box lengths must be positive")
    return rows, restricted


def _species(labels, atom_types, overrides):
    if any(not isinstance(label, str) or not _LABEL.fullmatch(label) for label in labels):
        raise ValueError("Invalid VASP species label")
    if not isinstance(overrides, dict) or overrides.keys() - set(labels):
        raise ValueError("mass_overrides must map source species labels to masses")
    counts = Counter(atom_types)
    species = []
    for type_id, label in enumerate(labels, 1):
        if label not in overrides and label not in _MASSES:
            raise ValueError(f"Specify a mass override for species {label}")
        mass = _number(overrides.get(label, _MASSES.get(label)))
        if mass <= 0:
            raise ValueError(f"Mass must be positive for species {label}")
        species.append(dict(type_id=type_id, symbol=label, count=counts[type_id], mass=mass,
                            mass_source="override" if label in overrides else "standard_atomic_weight"))
    return species


def _text(values):
    return " ".join(format(value, ".17g") for value in values)


def export_structure(filename, data, options={}):
    """Return (LAMMPS data bytes, JSON-ready metadata) for one VASP structure.

    Options are mass_overrides (g/mol by species label) and species (explicit
    count order for unlabeled VASP 4 inputs). No coordinates are idealized.
    """
    if (not isinstance(filename, str) or not filename or len(filename) > 255
            or any(ord(char) < 32 or char in "/\\" for char in filename)):
        raise ValueError("Expected a VASP structure filename")
    if not isinstance(data, bytes) or not 0 < len(data) <= _INPUT_LIMIT:
        raise ValueError("Structure input must be nonempty bytes of at most 128 MiB")
    if not isinstance(options, dict) or options.keys() - {"mass_overrides", "species"}:
        raise ValueError("Expected only mass_overrides and species options")
    supplied = options.get("species")
    if "species" in options and (not isinstance(supplied, (list, tuple)) or not supplied):
        raise ValueError("options.species must contain species labels in POSCAR count order")

    name = filename.lower()
    if name.endswith(".xml"):
        if supplied is not None:
            raise ValueError("vasprun.xml already supplies species")
        source_format = "vasprun.xml"
        basis, labels, atom_types, positions, masks = _vasprun(data)
    elif name.split(".")[0] in {"poscar", "contcar"} or name.endswith((".poscar", ".contcar")):
        source_format = "poscar"
        basis, labels, atom_types, positions, masks = _poscar(data, supplied)
    else:
        raise ValueError("Expected POSCAR, CONTCAR or vasprun.xml")

    species = _species(labels, atom_types, options.get("mass_overrides", {}))
    source_vectors, box = _restricted(basis)
    lx, ly, lz = (row[i] for i, row in enumerate(box))
    xy, xz, yz = box[1][0], box[2][0], box[2][1]
    lines = ["VASP structure handoff | units metal | atom_style atomic", "",
             f"{len(positions)} atoms", f"{len(species)} atom types", "",
             f"0 {lx:.17g} xlo xhi", f"0 {ly:.17g} ylo yhi", f"0 {lz:.17g} zlo zhi",
             f"{_text((xy, xz, yz))} xy xz yz", "", "Masses", ""]
    lines.extend(f"{row['type_id']} {row['mass']:.17g} # {row['symbol']}" for row in species)
    lines.extend(("", "Atoms # atomic", ""))
    for atom_id, (type_id, xyz) in enumerate(zip(atom_types, positions, strict=True), 1):
        images = tuple(floor(value) for value in xyz)
        # Default LAMMPS image flags have a signed ten-bit field per axis.
        if any(image < -512 or image > 511 for image in images):
            raise ValueError(f"Atom {atom_id} exceeds the LAMMPS image flag range")
        fractional = [value - image for value, image in zip(xyz, images)]
        cartesian = [fsum(f * v for f, v in zip(fractional, axis)) for axis in zip(*box)]
        lines.append(f"{atom_id} {type_id} {_text(cartesian)} {' '.join(map(str, images))}")

    metadata = dict(
        source=dict(filename=filename, format=source_format),
        atom_count=len(positions), atom_type_count=len(species), units="metal", atom_style="atomic",
        cell=dict(origin_A=[0.0, 0.0, 0.0], source_vectors_A=[list(row) for row in source_vectors],
                  vectors_A=[list(row) for row in box], lengths_A=[lx, ly, lz],
                  tilt_A=dict(xy=xy, xz=xz, yz=yz)),
        species=species,
    )
    if masks:
        metadata["source_selective_dynamics"] = masks
    return ("\n".join(lines) + "\n").encode("ascii"), metadata
