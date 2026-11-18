import base64
import struct
import unittest
import xml.etree.ElementTree as ET
import zlib

from packages.science.imports import validate_equipment
from packages.science.vtu_reader import read_mesh


def fixture():
    return ET.fromstring("""
<VTKFile type="UnstructuredGrid" byte_order="LittleEndian">
  <UnstructuredGrid>
    <Piece NumberOfPoints="8" NumberOfCells="2">
      <Points>
        <DataArray type="Float32" NumberOfComponents="3" Unit="mm" format="ascii">
          0 0 0  1 0 0  1 1 0  0 1 0  0 0 1  1 0 1  1 1 1  0 1 1
        </DataArray>
      </Points>
      <Cells>
        <DataArray type="Int64" Name="connectivity">0 1 3 4  0 1 2 3 4 5 6 7</DataArray>
        <DataArray type="Int32" Name="offsets">4 12</DataArray>
        <DataArray type="UInt8" Name="types">10 12</DataArray>
      </Cells>
      <PointData>
        <DataArray type="Float64" Name="T" NumberOfComponents="2" Units="K">
          1.5 2  3 4  5 6  7 8  9 10  11 12  13 14  15 16
        </DataArray>
      </PointData>
      <CellData><DataArray type="Int32" Name="T" Unit="1">1 2</DataArray></CellData>
    </Piece>
  </UnstructuredGrid>
</VTKFile>
""")


def encode(root, *, endian, compressed, appended, separate=True):
    root.set("byte_order", "BigEndian" if endian == ">" else "LittleEndian")
    root.set("header_type", "UInt64" if endian == ">" else "UInt32")
    if compressed:
        root.set("compressor", "vtkZLibDataCompressor")
    codes = {"Float32": "f", "Float64": "d", "Int64": "q", "Int32": "i", "UInt8": "B"}
    header_code = "Q" if endian == ">" else "I"
    records = []
    offset = 0
    for array in root.iter("DataArray"):
        code = codes[array.attrib["type"]]
        constructor = float if code in "fd" else int
        values = [constructor(token) for token in array.text.split()]
        data = struct.pack(endian + code * len(values), *values)
        if compressed:
            blocks = [zlib.compress(data[i:i + 16]) for i in range(0, len(data), 16)]
            items = [len(blocks), 16, len(data) % 16 or 16, *map(len, blocks)]
            data = b"".join(blocks)
        else:
            items = [len(data)]
        header = struct.pack(endian + header_code * len(items), *items)
        parts = (header, data) if separate else (header + data,)
        body = b"".join(base64.b64encode(part) for part in parts).decode("ascii")
        array.set("format", "appended" if appended else "binary")
        if appended:
            array.set("offset", str(offset))
            array.text = None
            records.append(body)
            offset += len(body)
        else:
            array.text = body
    if appended:
        ET.SubElement(root, "AppendedData", encoding="base64").text = "_" + "".join(records)


class VTUReaderTests(unittest.TestCase):
    def read(self, root, options=None):
        content = root if isinstance(root, bytes) else ET.tostring(root)
        return read_mesh("sample.vtu", content, options or {}, "artifact_mesh_01")

    def test_ascii_schema_and_unit_confirmation(self):
        result = self.read(fixture(), {"length_unit": " mm ", "field_units": {"point": {"T": "K"}}})
        validate_equipment(result)
        self.assertEqual(result["length_unit"], "mm")
        self.assertEqual(result["points"][-1], [0, 1, 1])
        self.assertEqual(result["cells"], [
            {"vtk_type": 10, "point_indices": [0, 1, 3, 4]},
            {"vtk_type": 12, "point_indices": list(range(8))},
        ])
        point, cell = result["fields"]
        self.assertEqual((point["name"], point["association"], point["unit"], point["components"]),
                         ("T", "point", "K", 2))
        self.assertEqual(point["values"][0], [1.5, 2])
        self.assertEqual(cell["values"], [[1], [2]])
        self.assertEqual(cell["unit"], "1")

    def test_explicit_units_fill_missing_metadata(self):
        root = fixture()
        del root.find(".//Points/DataArray").attrib["Unit"]
        del root.find(".//PointData/DataArray").attrib["Units"]
        with self.assertRaisesRegex(ValueError, "Points: missing unit.*length_unit"):
            self.read(root)
        self.assertEqual(
            self.read(root, {"length_unit": "mm", "field_units": {"point": {"T": "K"}}}),
            self.read(fixture()),
        )

    def test_explicit_units_cannot_relabel_known_units(self):
        with self.assertRaisesRegex(ValueError, "Points:.*'m' conflicts with native unit 'mm'"):
            self.read(fixture(), {"length_unit": "m"})
        with self.assertRaisesRegex(ValueError, "PointData field 'T':.*'°C' conflicts with native unit 'K'"):
            self.read(fixture(), {"field_units": {"point": {"T": "°C"}}})

    def test_ambiguous_native_units_are_rejected_even_with_explicit_units(self):
        root = fixture()
        coordinates = root.find(".//Points/DataArray")
        coordinates.set("Units", "m")
        with self.assertRaisesRegex(ValueError, "Points: conflicting native Unit/Units"):
            self.read(root, {"length_unit": "mm"})
        coordinates.set("Units", "mm")
        root.find(".//PointData/DataArray").set("Unit", "°C")
        with self.assertRaisesRegex(ValueError, "PointData field 'T': conflicting native Unit/Units"):
            self.read(root, {"field_units": {"point": {"T": "K"}}})

    def test_binary_variants_match_ascii(self):
        expected = self.read(fixture())
        for endian in "<>":
            for compressed in (False, True):
                for appended in (False, True):
                    for separate in (False, True):
                        with self.subTest(endian=endian, compressed=compressed, appended=appended,
                                          separate=separate):
                            root = fixture()
                            encode(root, endian=endian, compressed=compressed, appended=appended,
                                   separate=separate)
                            self.assertEqual(self.read(root), expected)

    def test_missing_unit_and_typo(self):
        root = fixture()
        del root.find(".//PointData/DataArray").attrib["Units"]
        with self.assertRaisesRegex(ValueError, r"PointData field 'T'.*field_units"):
            self.read(root)
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            self.read(fixture(), {"field_units": {"cell": {"typo": "K"}}})

    def test_invalid_arrays_and_topology(self):
        cases = (
            ("Points/DataArray", "NaN " * 24, "non-finite"),
            ("Points/DataArray", "1e100 " * 24, "Non-finite"),
            ("Cells/DataArray[@Name='types']", "10 22", "unsupported VTK cell type"),
            ("Cells/DataArray[@Name='types']", "10 268", "outside UInt8 range"),
            ("Cells/DataArray[@Name='offsets']", "4 11", "invalid connectivity offset"),
            ("Cells/DataArray[@Name='connectivity']", "0 1 3 8 0 1 2 3 4 5 6 7", "out of range"),
            ("Cells/DataArray[@Name='connectivity']", "0 1 3 3 0 1 2 3 4 5 6 7", "repeated point"),
            ("CellData/DataArray", "1", "Wrong ASCII value count"),
        )
        for path, body, message in cases:
            with self.subTest(path=path, message=message):
                root = fixture()
                root.find(".//" + path).text = body
                with self.assertRaisesRegex(ValueError, message):
                    self.read(root)

    def test_invalid_compressed_header_and_stream(self):
        root = fixture()
        encode(root, endian="<", compressed=True, appended=False)
        node = root.find(".//Points/DataArray")
        node.text = base64.b64encode(struct.pack("<III", 8193, 32, 1)).decode()
        with self.assertRaisesRegex(ValueError, "block table"):
            self.read(root)
        node.text = base64.b64encode(struct.pack("<IIII", 1, 96, 96, 2) + b"xx").decode()
        with self.assertRaisesRegex(ValueError, "Points: .*decompress"):
            self.read(root)

    def test_reject_dtd_external_and_multiple_pieces(self):
        root = fixture()
        with self.assertRaisesRegex(ValueError, "DOCTYPE"):
            self.read(b'<!DOCTYPE VTKFile SYSTEM "file:///external.dtd">' + ET.tostring(root))
        piece = root.find(".//Piece")
        piece.set("Source", "../external.vtu")
        with self.assertRaisesRegex(ValueError, "External Piece"):
            self.read(root)
        ET.SubElement(root.find("UnstructuredGrid"), "Piece")
        with self.assertRaisesRegex(ValueError, "multi-piece"):
            self.read(root)

    def test_point_only_mesh_empty_topology(self):
        root = fixture()
        piece = root.find(".//Piece")
        piece.set("NumberOfCells", "0")
        for node in piece.find("Cells"):
            node.text = ""
        piece.find("CellData/DataArray").text = ""
        mesh = self.read(root)
        self.assertEqual(mesh["cells"], [])
        self.assertEqual(mesh["fields"][1]["values"], [])
        validate_equipment(mesh)
