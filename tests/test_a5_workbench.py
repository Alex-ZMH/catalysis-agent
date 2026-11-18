"""A5 independent Cartesian and analytic field oracles, shared with browser acceptance."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from packages.agent.workspace import Workspace
from packages.check import link_result


def md_case():
    # Expected Cartesian positions are hand-calculated, independent of the dump reader.
    steps = (100, 120, 160)
    fractional = [
        [(7, .25, .5, .5), (23, .875, .25, .25), (41, .5, .75, .75)],
        [(41, .625, .75, .75), (7, .375, .5, .5), (23, 0, .25, .25)],
        [(23, .125, .25, .25), (41, .75, .75, .75), (7, .5, .5, .5)],
    ]
    cartesian = [
        {7: [.5, 5.5, 4], 23: [5.25, 4.25, 2.5], 41: [2.75, 6.75, 5.5]},
        {7: [1.5, 5.5, 4], 23: [-1.75, 4.25, 2.5], 41: [3.75, 6.75, 5.5]},
        {7: [3.5, 5.5, 4], 23: [.25, 4.25, 2.5], 41: [5.75, 6.75, 5.5]},
    ]
    vectors = [[8, 0, 0], [2, 4, 0], [-1, 1, 6]]
    dump, frames = [], []
    for row, step in enumerate(steps):
        shift = int(row == 2)
        dump += ["ITEM: TIMESTEP", str(step), "ITEM: NUMBER OF ATOMS", "3",
                 "ITEM: BOX BOUNDS xy xz yz pp ff pp", f"{-3 + shift} {8 + shift} 2",
                 "3 8 -1", "1 7 1", "ITEM: ATOMS type zs id xs ys"]
        for atom_id, x, y, z in fractional[row]:
            dump.append(f"1 {z} {atom_id} {x} {y}")
        frames.append({"timestep": step, "cell": {"origin": [-2 + shift, 3, 1],
                       "vectors": vectors, "periodic": [True, False, True]},
                       "atoms": [{"id": atom_id, "position": pos}
                                 for atom_id, pos in reversed(cartesian[row].items())]})
    reference = {"length_unit": "angstrom", "coordinate_mode": "wrapped",
                 "absolute_tolerance": 1e-9, "frames": frames[::-1]}
    return "tilted-trajectory.lammpstrj", ("\n".join(dump) + "\n").encode(), {"length_unit": "angstrom"}, reference


def equipment_case():
    # Two adjoining voxels written in the native VTK_HEXAHEDRON point ordering.
    points = [(x, y, z) for x in (0, 1, 2) for z in (0, 1) for y in (0, 1)]
    positions = " ".join(f"{x} {y} {z}" for x, y, z in points)
    temperature = " ".join(str(300 + 10*x + 4*y - 2*z) for x, y, z in points)
    mesh = f"""<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian">
 <UnstructuredGrid><Piece NumberOfPoints="12" NumberOfCells="2">
  <PointData Scalars="T"><DataArray Name="T" type="Float64" format="ascii">{temperature}</DataArray></PointData>
  <CellData Scalars="T"><DataArray Name="T" type="Float64" format="ascii">315 335</DataArray></CellData>
  <Points><DataArray NumberOfComponents="3" type="Float64" format="ascii">{positions}</DataArray></Points>
  <Cells><DataArray Name="connectivity" type="Int32" format="ascii">0 4 5 1 2 6 7 3 4 8 9 5 6 10 11 7</DataArray>
   <DataArray Name="offsets" type="Int32" format="ascii">8 16</DataArray>
   <DataArray Name="types" type="UInt8" format="ascii">12 12</DataArray></Cells>
 </Piece></UnstructuredGrid>
</VTKFile>"""
    options = {"length_unit": "m", "field_units": {"point": {"T": "K"}, "cell": {"T": "K"}}}
    profiles = []
    for association, values in [("point", [302.5, 305.5, 308.5, 311.5, 314.5, 317.5]),
                                ("cell", [315, 315, 315, 335, 335, 335])]:
        profiles.append({"a": [.25, .25, .5], "b": [1.75, .25, .5],
                         "field": {"name": "T", "association": association,
                                   "selection": {"kind": "component", "index": 0}},
                         "fractions": [0, .2, .4, .6, .8, 1], "unit": "K", "values": values,
                         "absolute_tolerance": 1e-9, "relative_tolerance": 0})
    return "two-zones.vtu", mesh.encode(), options, {"length_unit": "m", "profiles": profiles}


CASES = {"md": md_case, "equipment": equipment_case}


class RawImportAcceptance(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Workspace(Path(directory.name), "fixture", "Astra", "1" * 40)

    def run_case(self, kind, ref=True):
        name, blob, options, reference = CASES[kind]()
        ref_bytes = json.dumps(reference if ref is True else ref).encode()
        attachment = None if ref is None else ("independent.json", ref_bytes)
        run = self.store.analyze(kind, name, blob, options, "synthetic", attachment)
        self.assertEqual(self.store.download(run["id"], run["raw_id"]), (name, blob))
        manifest = self.store.manifest(run["id"])
        if attachment:
            self.assertEqual(self.store.download(run["id"], run["reference_id"]), attachment)
            self.assertEqual(set(manifest["inputs"]), {run["raw_id"], run["reference_id"]})
        else:
            self.assertIsNone(run["reference_id"])
        result = next(a for a in run["artifacts"] if a["name"] == "result.json")
        raw_result = self.store.download(run["id"], result["id"])[1]
        self.assertEqual(hashlib.sha256(raw_result).hexdigest(), result["sha256"])
        self.assertEqual(json.loads(raw_result), run["result"])
        link_result(kind, run["result"], raw_result, manifest)
        return run

    def test_trajectory_by_step_id_and_box(self):
        run = self.run_case("md")
        record = run["result"]["dump"]
        oracle = md_case()[-1]
        self.assertEqual(record["length_unit"], oracle["length_unit"])
        self.assertEqual(record["coordinate_mode"], oracle["coordinate_mode"])
        expected = {frame["timestep"]: frame for frame in oracle["frames"]}
        self.assertEqual(set(expected), {frame["timestep"] for frame in record["frames"]})
        for frame in record["frames"]:
            target = expected[frame["timestep"]]
            self.assertEqual(frame["cell"], target["cell"])
            self.assertEqual({a["id"]: a["position"] for a in frame["atoms"]},
                             {a["id"]: a["position"] for a in target["atoms"]})

    def test_fields_with_identical_names_and_distinct_associations(self):
        run = self.run_case("equipment")
        record = run["result"]
        expected = {p["field"]["association"]: p for p in equipment_case()[-1]["profiles"]}
        self.assertEqual(len(record["line_profiles"]), 2)
        for profile in record["line_profiles"]:
            reference = expected[profile["field"]["association"]]
            self.assertEqual(profile["reference"]["reference_artifact_id"], run["reference_id"])
            for row, fraction, target in zip(profile["samples"], reference["fractions"], reference["values"], strict=True):
                self.assertAlmostEqual(row["fraction"], fraction)
                self.assertAlmostEqual(row["value"], target, delta=1e-9)

    def test_reference_discrepancies_are_published_with_raw_results(self):
        for kind, change in [
            ("md", lambda r: r["frames"][1]["atoms"][0]["position"].__setitem__(0, 20)),
            ("md", lambda r: r["frames"][1]["cell"]["periodic"].__setitem__(1, True)),
            ("md", lambda r: r.update(length_unit="nm")),
            ("equipment", lambda r: r["profiles"][0]["values"].__setitem__(2, 303)),
            ("equipment", lambda r: r["profiles"][1].update(unit="degC")),
        ]:
            ref = copy.deepcopy(CASES[kind]()[-1])
            change(ref)
            with self.subTest(kind=kind):
                run = self.run_case(kind, ref)
                self.assertEqual(run["details"]["reference_status"], "mismatch")
                self.assertTrue(run["details"]["reference_error"])
                if kind == "md":
                    self.assertEqual(len(run["result"]["dump"]["frames"]), 3)
                else:
                    self.assertEqual(len(run["result"]["line_profiles"]), 2)
                    self.assertEqual(sum("reference" in p for p in run["result"]["line_profiles"]), 1)
        self.assertEqual(len(self.store.recent()), 5)

    def test_raw_only_and_replay_cache_respect_reference_bytes(self):
        for kind in CASES:
            raw_only = self.run_case(kind, None)
            checked = self.run_case(kind)
            self.assertNotEqual(raw_only["id"], checked["id"])
            self.assertEqual(checked["id"], self.run_case(kind)["id"])
            reference = CASES[kind]()[-1]
            if kind == "md":
                reference["absolute_tolerance"] = 1e-7
            else:
                reference["profiles"][0]["absolute_tolerance"] = 1e-7
            self.assertNotEqual(checked["id"], self.run_case(kind, reference)["id"])
