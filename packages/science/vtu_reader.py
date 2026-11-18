"""Read bounded, single-piece VTK XML unstructured meshes."""

import base64
import binascii
import re
import zlib

import numpy as np
from lxml import etree

from .imports import _CELL_ARITY


MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_ENTITIES = 500_000
MAX_VALUES = 4_000_000
MAX_ARRAYS = 256
MAX_COMPONENTS = 64
MAX_BLOCKS = 8192

_TYPES = {
    **{f"Int{n}": f"i{n // 8}" for n in (8, 16, 32, 64)},
    **{f"UInt{n}": f"u{n // 8}" for n in (8, 16, 32, 64)},
    "Float32": "f4", "Float64": "f8",
}
_INT = re.compile(r"[+-]?[0-9]{1,20}")
_FLOAT = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def _count(value, minimum, maximum, label):
    if value is None or not re.fullmatch(r"[0-9]{1,10}", value.strip()):
        raise ValueError(f"{label} must be an unsigned integer")
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return number


def _children(node, allowed, label):
    if any(child.tag not in allowed for child in node):
        raise ValueError(f"{label} contains an unsupported XML element")


def _one(node, tag, required=True):
    nodes = node.findall(tag)
    if len(nodes) > 1 or (required and not nodes):
        raise ValueError(f"{node.tag} requires a single {tag}")
    return nodes[0] if nodes else None


def _base64(text):
    # VTK may encode the header and payload separately, with padding between them.
    compact = "".join(text.split())
    padding = compact.find("=")
    split = len(compact) if padding < 0 else (padding // 4 + 1) * 4
    try:
        data = base64.b64decode(compact[:split], validate=True)
        if split < len(compact):
            data += base64.b64decode(compact[split:], validate=True)
    except binascii.Error as error:
        raise ValueError("Invalid base64 data") from error
    return data


def _binary(data, header, compressed, expected):
    width = header.itemsize
    if not compressed:
        if len(data) < width:
            raise ValueError("Missing binary byte-count header")
        size = int(np.frombuffer(data, header, count=1)[0])
        if size != len(data) - width or expected != size:
            raise ValueError("Invalid binary byte count")
        return memoryview(data)[width:]

    if len(data) < 3 * width:
        raise ValueError("Incomplete zlib header")
    blocks, block_size, last_size = map(int, np.frombuffer(data, header, count=3))
    start = (3 + blocks) * width
    if blocks > MAX_BLOCKS or len(data) < start or last_size > block_size:
        raise ValueError("Invalid zlib block table")
    total = ((blocks - 1) * block_size + (last_size or block_size)) if blocks else 0
    if expected != total:
        raise ValueError("Invalid zlib expanded byte count")
    result = bytearray()
    for index, size in enumerate(np.frombuffer(data, header, count=blocks, offset=3 * width)):
        end = start + int(size)
        if end > len(data):
            raise ValueError("Truncated zlib block")
        block_bytes = (last_size or block_size) if index == blocks - 1 else block_size
        decoder = zlib.decompressobj()
        block = decoder.decompress(memoryview(data)[start:end], block_bytes + 1)
        if len(block) != block_bytes or not decoder.eof or decoder.unused_data:
            raise ValueError("Invalid zlib block length or stream")
        result.extend(block)
        start = end
    if start != len(data):
        raise ValueError("Trailing bytes after zlib blocks")
    return result


class _Arrays:
    def __init__(self, root):
        byte_order = root.get("byte_order", "LittleEndian")
        header_type = root.get("header_type", "UInt32")
        compressor = root.get("compressor")
        if byte_order not in {"LittleEndian", "BigEndian"} or header_type not in {"UInt32", "UInt64"}:
            raise ValueError("Unsupported VTK byte_order or header_type")
        if compressor not in {None, "vtkZLibDataCompressor"}:
            raise ValueError(f"Unsupported VTK compressor {compressor!r}")
        self.endian = "<" if byte_order == "LittleEndian" else ">"
        self.header = np.dtype(self.endian + _TYPES[header_type])
        self.compressed = compressor is not None
        self.remaining = MAX_VALUES
        self.appended = {}
        arrays = root.findall(".//DataArray")
        if len(arrays) > MAX_ARRAYS:
            raise ValueError("Too many VTU DataArrays")
        appended = _one(root, "AppendedData", required=False)
        offsets = []
        for node in arrays:
            if node.get("format") == "appended":
                offsets.append(_count(node.get("offset"), 0, MAX_FILE_BYTES, "appended offset"))
        if appended is None:
            if offsets:
                raise ValueError("Missing AppendedData")
            return
        if appended.get("encoding") != "base64" or len(appended):
            raise ValueError("AppendedData requires base64 encoding")
        data = (appended.text or "").strip()
        if not data.startswith("_"):
            raise ValueError("AppendedData requires an underscore prefix")
        data = data[1:]
        offsets = sorted(set(offsets))
        if not offsets or offsets[0] != 0 or offsets[-1] >= len(data):
            raise ValueError("Invalid AppendedData offsets")
        self.appended = {
            offset: data[offset:end]
            for offset, end in zip(offsets, offsets[1:] + [len(data)])
        }

    def read(self, node, label, expected, integer=False):
        try:
            if "NumberOfTuples" in node.attrib:
                tuples = _attribute_count(node, "NumberOfTuples", 0, MAX_VALUES)
                components = _attribute_count(node, "NumberOfComponents", 1, MAX_COMPONENTS, "1")
                if tuples * components != expected:
                    raise ValueError("NumberOfTuples does not match entity count")
            return self._read(node, expected, integer)
        except (ValueError, OverflowError, zlib.error) as error:
            raise ValueError(f"{label}: {error}") from error

    def _read(self, node, expected, integer):
        _children(node, {"InformationKey"}, "DataArray")
        if any((child.tail or "").strip() for child in node):
            raise ValueError("Unexpected data after DataArray metadata")
        if any(key in node.attrib for key in ("Source", "source", "file", "href", "TimeStep")):
            raise ValueError("External or time-dependent DataArrays are unsupported")
        vtk_type = node.get("type")
        if vtk_type not in _TYPES:
            raise ValueError(f"Unsupported numeric type {vtk_type!r}")
        dtype = np.dtype(self.endian + _TYPES[vtk_type])
        is_integer = dtype.kind in "iu"
        if integer and not is_integer:
            raise ValueError("Topology requires an integer DataArray")
        if expected > self.remaining:
            raise ValueError("Numeric value limit exceeded")
        mode = node.get("format", "ascii")
        body = node.text or ""
        if mode == "ascii":
            tokens = body.split(None, expected)
            if len(tokens) != expected:
                raise ValueError("Wrong ASCII value count or numeric value limit exceeded")
            if is_integer:
                bounds = np.iinfo(dtype)
                values = np.empty(len(tokens), dtype=dtype)
                for index, token in enumerate(tokens):
                    if not _INT.fullmatch(token):
                        raise ValueError("Invalid ASCII integer")
                    number = int(token)
                    if not bounds.min <= number <= bounds.max:
                        raise ValueError(f"ASCII integer outside {vtk_type} range")
                    values[index] = number
            else:
                if any(len(token) > 128 or not _FLOAT.fullmatch(token) for token in tokens):
                    raise ValueError("Invalid or non-finite ASCII floating-point value")
                with np.errstate(over="ignore"):
                    values = np.asarray(tokens, dtype=dtype)
        elif mode in {"binary", "appended"}:
            if mode == "appended":
                if body.strip():
                    raise ValueError("Appended DataArray contains inline data")
                body = self.appended[int(node.get("offset"))]
            payload = _binary(
                _base64(body), self.header, self.compressed,
                expected * dtype.itemsize,
            )
            if len(payload) % dtype.itemsize:
                raise ValueError("Binary data does not align with its numeric type")
            values = np.frombuffer(payload, dtype=dtype)
        else:
            raise ValueError(f"Unsupported DataArray format {mode!r}")
        if not is_integer and not np.isfinite(values).all():
            raise ValueError("Non-finite numeric value")
        self.remaining -= values.size
        return values


def _attribute_count(node, key, minimum, maximum, default=None):
    return _count(node.get(key, default), minimum, maximum, f"{node.tag} {key}")


def _tuples(reader, node, label, count, components):
    return reader.read(node, label, count * components).reshape(count, components).tolist()


def _cells(reader, piece, count, points):
    group = _one(piece, "Cells")
    _children(group, {"DataArray"}, "Cells")
    arrays = {node.get("Name"): node for node in group}
    if set(arrays) != {"connectivity", "offsets", "types"} or len(group) != 3:
        raise ValueError("Cells requires exactly one each of connectivity, offsets, and types")
    for node in arrays.values():
        _attribute_count(node, "NumberOfComponents", 1, 1, "1")
    topology = reader.read(arrays["types"], "Cells/types", count, integer=True).tolist()
    arities = []
    for index, vtk_type in enumerate(topology):
        if vtk_type not in _CELL_ARITY:
            raise ValueError(f"Cell {index}: unsupported VTK cell type {vtk_type}")
        arities.append(_CELL_ARITY[vtk_type])
    connectivity = reader.read(
        arrays["connectivity"], "Cells/connectivity", sum(arities), integer=True,
    ).tolist()
    offsets = reader.read(arrays["offsets"], "Cells/offsets", count, integer=True).tolist()
    cells = []
    start = 0
    for index, (vtk_type, arity, end) in enumerate(zip(topology, arities, offsets)):
        if end != start + arity:
            raise ValueError(f"Cell {index}: invalid connectivity offset for VTK type {vtk_type}")
        indices = connectivity[start:end]
        if any(point < 0 or point >= points for point in indices):
            raise ValueError(f"Cell {index}: point index out of range")
        if len(set(indices)) != arity:
            raise ValueError(f"Cell {index}: repeated point index")
        cells.append({"vtk_type": vtk_type, "point_indices": indices})
        start = end
    return cells


def _unit(node, override, label, option):
    native = {text.strip() for key in ("Unit", "Units") if (text := node.get(key)) and text.strip()}
    if len(native) > 1:
        raise ValueError(f"{label}: conflicting native Unit/Units metadata")
    declared = next(iter(native), None)
    if override is not None:
        if not isinstance(override, str) or not override.strip():
            raise ValueError(f"{label}: {option} must be a nonblank unit label")
        override = override.strip()
        if declared is not None and override != declared:
            raise ValueError(f"{label}: {option} unit {override!r} conflicts with native unit {declared!r}")
        return override
    if declared is None:
        raise ValueError(f"{label}: missing unit. Supply {option} or Unit/Units metadata")
    return declared


def _read_mesh(content, options, raw_id):
    if not isinstance(content, bytes) or len(content) > MAX_FILE_BYTES:
        raise ValueError("VTU content must be bytes and at most 32 MiB")
    if not isinstance(options, dict):
        raise ValueError("VTU options must be a mapping")
    if not isinstance(raw_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", raw_id):
        raise ValueError("Invalid raw_artifact_id")
    units = options.get("field_units", {})
    if (not isinstance(units, dict) or units.keys() - {"point", "cell"}
            or any(not isinstance(group, dict) for group in units.values())):
        raise ValueError("field_units must map point/cell associations to field name/unit mappings")
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                             remove_comments=True, remove_pis=True)
    try:
        root = etree.fromstring(content, parser)
    except etree.XMLSyntaxError as error:
        raise ValueError("Invalid VTU XML (raw appended data is unsupported)") from error
    if root.getroottree().docinfo.doctype:
        raise ValueError("VTU XML must not contain a DOCTYPE")
    if root.tag != "VTKFile" or root.get("type") != "UnstructuredGrid":
        raise ValueError("Expected VTKFile type UnstructuredGrid")
    _children(root, {"UnstructuredGrid", "AppendedData"}, "VTKFile")
    grid = _one(root, "UnstructuredGrid")
    _children(grid, {"Piece", "FieldData"}, "UnstructuredGrid")
    pieces = grid.findall("Piece")
    if len(pieces) != 1:
        raise ValueError("VTU requires exactly one Piece; multi-piece meshes are unsupported")
    piece = pieces[0]
    if "Source" in piece.attrib:
        raise ValueError("External Piece sources are unsupported")
    if "TimeValues" in grid.attrib:
        raise ValueError("Time-dependent VTU meshes are unsupported")
    _children(piece, {"Points", "Cells", "PointData", "CellData", "FieldData"}, "Piece")
    points_count = _attribute_count(piece, "NumberOfPoints", 1, MAX_ENTITIES)
    cells_count = _attribute_count(piece, "NumberOfCells", 0, MAX_ENTITIES)
    points_group = _one(piece, "Points")
    _children(points_group, {"DataArray"}, "Points")
    coordinates = _one(points_group, "DataArray")
    _attribute_count(coordinates, "NumberOfComponents", 3, 3)
    length_unit = _unit(coordinates, options.get("length_unit"), "Points", "length_unit")
    reader = _Arrays(root)
    points = _tuples(reader, coordinates, "Points", points_count, 3)
    cells = _cells(reader, piece, cells_count, points_count)
    fields = []
    for tag, association, count in (("PointData", "point", points_count), ("CellData", "cell", cells_count)):
        group = _one(piece, tag, required=False)
        overrides = units.get(association, {})
        names = set()
        if group is not None:
            _children(group, {"DataArray"}, tag)
            for node in group:
                name = node.get("Name")
                if not name or not name.strip() or name in names:
                    raise ValueError(f"{tag} names must be nonblank and unique")
                names.add(name)
                label = f"{tag} field {name!r}"
                components = _attribute_count(node, "NumberOfComponents", 1, MAX_COMPONENTS, "1")
                unit = _unit(node, overrides.get(name), label, f"field_units[{association!r}][{name!r}]")
                fields.append({
                    "name": name, "association": association, "components": components, "unit": unit,
                    "values": _tuples(reader, node, label, count, components),
                })
        unknown = overrides.keys() - names
        if unknown:
            raise ValueError(f"field_units[{association!r}] refers to unknown fields: {unknown!r}")
    if not fields:
        raise ValueError("VTU requires at least one PointData or CellData field")
    return {
        "raw_artifact_id": raw_id, "length_unit": length_unit,
        "points": points, "cells": cells, "fields": fields,
    }


def read_mesh(filename, content, options, raw_id) -> dict:
    """Normalize VTU bytes, using filename only to identify the input in errors."""
    try:
        return _read_mesh(content, options, raw_id)
    except ValueError as error:
        raise ValueError(f"{filename}: {error}") from error
