# VTU mesh import

`packages.science.vtu_reader.read_mesh(filename, content, options, raw_id)` reads VTU
XML bytes and returns a dictionary matching `contracts/v1/equipment.schema.json`.
The filename identifies the input in errors. The reader uses the provided bytes as
its only input. A rejected file or option raises `ValueError`.

## Units and output

Pass `options={}` when the coordinate and field arrays all carry unit metadata.
Use options to supply missing units or confirm the labels from the file.

```python
options = {
    "length_unit": "mm",
    "field_units": {
        "point": {"T": "K", "velocity": "m/s"},
        "cell": {"T": "K", "material_id": "1"},
    },
}
```

The coordinate array and each field use their nonblank native `Unit` or `Units`
attribute when present. If both attributes are nonblank, their labels must agree.
An explicit option may supply a missing label or confirm a matching label.
Conflicting native labels and explicit labels that disagree with native metadata
both raise errors. Labels are compared exactly after trimming surrounding
whitespace. The reader does not convert numerical values. Use `"1"` for
dimensionless quantities.

Point and cell data are returned in XML array order within each association, with
point fields first. The same field name can occur in both associations. Every
field is imported and needs a unit. Unknown names in `field_units` are rejected. A
scalar is a one-component tuple. Mesh point order, cell order, local point
indices within each cell, and field component order are preserved. At least one
point and one field are required. A mesh with zero cells uses empty connectivity,
offsets, and types arrays.

## Supported files

- One serial XML `VTKFile` of type `UnstructuredGrid` with a single `Piece`.
  Coordinates use one three-component numeric array. Cells use the integer
  `connectivity`, `offsets`, and `types` arrays. Offsets are cumulative ends.
- VTK fixed-arity linear types 1, 3, 5, 8, 9, 10, 11, 12, 13, and 14, including
  tetrahedra and hexahedra. Checks cover cell arity, offsets, point index bounds,
  and repeated point indices. Geometric quality and orientation are outside the
  reader's scope.
- Signed and unsigned VTK integer types of 8, 16, 32, and 64 bits, plus
  `Float32` and `Float64`. All coordinates and field values must be finite.
- ASCII, inline base64 binary, and base64 appended data. Appended offsets count
  encoded characters from immediately after the underscore. Use contiguous
  base64 data in the appended section for byte-exact offset addressing.
- Binary in little- or big-endian byte order with `UInt32` or `UInt64` headers.
  Binary data may be uncompressed or use `vtkZLibDataCompressor`. Base64 accepts
  both a single encoding and separately encoded headers and payloads.
- Dataset-level `FieldData` and `InformationKey` metadata are outside the
  point/cell field model and do not become output fields.

Limits are 32 MiB of input, 500,000 points and 500,000 cells, 256 data arrays,
64 components per field, 4 million numeric values across decoded geometry,
topology, and fields, and 8,192 zlib blocks per array. The XML parser also
enforces its standard depth and text-node limits.

Multi-piece and parallel files, time-dependent arrays, raw appended data,
non-zlib compressors, variable-arity cells, higher-order cells, and nonnumeric
point/cell arrays are unsupported. DTDs and external piece references are
rejected. External entities are never resolved.
