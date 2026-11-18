"""Offline synthetic VASP XML import and security regression cases."""

import io
import json
import zipfile
from collections import Counter
from unittest import TestCase
from unittest.mock import patch
from xml.sax.saxutils import escape

from packages.check import artifact_links
from packages.science import adsorption, vasp


def _xml(elements, positions, basis, grid, energy, *, cutoff=500, failed=False, fixed=0):
    potentials = {"Fe": (55.845, 8, "PAW_PBE Fe 06Sep2000"),
                  "O": (15.999, 6, "PAW_PBE O 08Apr2002")}
    types = list(dict.fromkeys(elements))
    counts = Counter(elements)

    def vec(values):
        return "<v>" + " ".join(map(str, values)) + "</v>"

    def cells(values):
        return "<rc>" + "".join(f"<c>{escape(str(value))}</c>" for value in values) + "</rc>"

    def array(name, rows):
        return f'<varray name="{name}">' + "".join(map(vec, rows)) + "</varray>"

    def scalar(name, value):
        return f'<i name="{name}">{value}</i>'

    def energy_node(value):
        return "<energy>" + scalar("e_0_energy", value + 0.02) + scalar(
            "e_wo_entrp", value + 0.03) + scalar("e_fr_energy", value) + "</energy>"

    def geometry(name=""):
        return (f"<structure{name}><crystal>" + array("basis", basis) + "</crystal>"
                + array("positions", positions) + "</structure>")

    is_gas = elements == ["O", "O"]
    n_scf = 6 if failed else 3
    delta = 0.002 if failed else 0.0000002
    scf = "".join(f"<scstep>{energy_node(energy + delta * step)}</scstep>"
                  for step in reversed(range(n_scf)))
    params = {"GGA": "PE", "ISPIN": 2, "ENCUT": cutoff,
              "NELECT": sum(potentials[symbol][1] for symbol in elements),
              "ISMEAR": 0 if is_gas else 1, "SIGMA": 0.05,
              "EDIFF": "1E-6", "EDIFFG": -0.02, "NELM": 6, "NSW": 40, "IBRION": 2}
    initial = geometry(' name="initialpos"').replace("</structure>",
        array("selective", [["F"] * 3] * fixed + [["T"] * 3] * (len(elements) - fixed))
        + "</structure>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<modeling>'
            + "<generator>" + scalar("program", "vasp") + scalar("version", "6.4.3") + "</generator>"
            + '<incar>' + scalar("ENCUT", cutoff) + '</incar><parameters><separator name="electronic">'
            + "".join(scalar(key, value) for key, value in params.items()) + "</separator></parameters>"
            + '<kpoints><generation param="Gamma"><v name="divisions">'
            + " ".join(map(str, grid)) + '</v><v name="usershift">0 0 0</v></generation></kpoints>'
            + '<atominfo><array name="atoms"><set>'
            + "".join(cells((symbol, types.index(symbol) + 1)) for symbol in elements)
            + '</set></array><array name="atomtypes"><set>'
            + "".join(cells((counts[symbol], symbol, *potentials[symbol])) for symbol in types)
            + "</set></array></atominfo>" + initial
            + "<calculation>" + geometry() + energy_node(energy + 1) + "</calculation>"
            + "<calculation>" + scf + geometry()
            + array("forces", [[0.4, 0, 0]] * fixed + [[0, 0, 0.008]] * (len(elements) - fixed))
            + energy_node(energy) + "</calculation>" + geometry(' name="finalpos"')
            + "</modeling>").encode()


def _study():
    sources = {}
    files = {}

    def evidence(key, body):
        path = f"evidence/{key}.json"
        sources[key] = path
        files[path] = json.dumps({"synthetic": True, "record": body}).encode()
        return key

    def run(name, elements, positions, basis, grid, energy, state, *, fixed=0, **xml):
        path = f"{name}/vasprun.xml"
        files[path] = _xml(elements, positions, basis, grid, energy, fixed=fixed, **xml)
        return dict(structure_id=name, file=path, magnetic_state=state,
                    geometry_history="relaxation",
                    protocol_evidence_id=evidence(f"protocol-{name}", {
                        "magnetic_state": state, "geometry_history": "synthetic ionic relaxation",
                    }))

    lattice = [[6, 0, 0], [1.2, 5.8, 0], [0, 0, 23]]
    slab_pos = [[0.25, 0.25, 0.40], [0.75, 0.75, 0.60]]
    slab_atoms = ["Fe", "Fe"]
    bulk = run("bulk", slab_atoms, [[0, 0, 0], [0.5, 0.5, 0.5]],
               [[3, 0, 0], [0, 3, 0], [0, 0, 3]], [7, 7, 7], -16, "FM")
    clean = run("slab", slab_atoms, slab_pos, lattice, [3, 3, 1], -15, "FM", fixed=1)
    fixed = evidence("layers", {"fixed_indices_zero_based": [0]})
    clean.update(bulk_structure_id="bulk", miller_indices=[1, 1, 0], termination="Fe",
                 slab_thickness_angstrom=5, vacuum_angstrom=18, fixed_layers_id=fixed,
                 bulk_to_slab_atom_map_id=evidence("map-bulk", {"bulk_to_slab": [0, 1]}),
                 finite_size_check={"evidence_id": evidence("size", {"mock_effects_eV": [0.01, 0.005]}),
                                    "thickness_effect_eV": 0.01, "vacuum_effect_eV": 0.005,
                                    "limit_eV": 0.02})
    gas = run("oxygen", ["O", "O"], [[0.5, 0.5, 0.47], [0.5, 0.5, 0.53]],
              [[18, 0, 0], [0, 19, 0], [0, 0, 20]], [1, 1, 1], -10, "triplet")
    gas["isolation_check"] = {"evidence_id": evidence("isolated", {"mock_effect_eV": 0.003}),
                              "effect_eV": 0.003, "limit_eV": 0.01}
    configs = []
    for name, sites, energy, kwargs in (
        ("top", [[0.75, 0.75, 0.67]], -21.5, {}),
        ("bridge", [[0.5, 0.5, 0.67], [0.3, 0.7, 0.69]], -27, {}),
        ("hollow", [[0.55, 0.65, 0.66]], -22, {"failed": True}),
        ("variant", [[0.3, 0.3, 0.68]], -24, {"cutoff": 560}),
    ):
        config = run(name, slab_atoms + ["O"] * len(sites), slab_pos + sites,
                     lattice, [3, 3, 1], energy, "FM", fixed=1, **kwargs)
        config.update(site=name, clean_structure_id="slab",
                      clean_to_adsorbed_atom_map_id=evidence(f"map-{name}", {"clean_to_adsorbed": [0, 1]}),
                      fixed_layers_id=fixed, vacuum_angstrom=18,
                      adsorbed_units=len(sites), reference_coefficients={"oxygen": len(sites) / 2})
        configs.append(config)
    return dict(adsorbate_formula={"O": 1}, bulk=bulk, clean_slab=clean,
                configurations=configs, gas_references=[gas], evidence=sources), files


def _bundle(study, files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        archive.writestr("study.json", json.dumps(study, ensure_ascii=False))
    return out.getvalue()


def demo():
    """Return (filename, ZIP bytes, UI options) for offline E2E."""
    return "synthetic-vasp-sites.zip", _bundle(*_study()), {}


class VaspImportTests(TestCase):
    def run_import(self, data=None, options=None):
        filename, default, _ = demo()
        registered = {}

        def register(name, content):
            key = f"artifact-{len(registered)}"
            registered[key] = name, content
            return key

        result = vasp.analyze(filename, default if data is None else data, options or {},
                              "synthetic", "raw-upload", register)
        return *result, registered

    def test_demo_publishes_v1_artifact_links_and_rankings(self):
        source, result, extra, registered = self.run_import()
        adsorption.validate_result(result, source)
        self.assertLessEqual(set(artifact_links(source)) | set(artifact_links(result)), registered.keys())
        ids = {row["structure_id"]: row["logical_id"] for row in extra["runs"]}
        keyed = {ids[row["structure_id"]]: row for row in result["results"]}
        self.assertEqual([ids[key] for key in extra["ranking"]], ["top", "bridge"])
        self.assertEqual(keyed["top"]["adsorption_energy"], -1.5)
        self.assertEqual(keyed["bridge"]["adsorption_energy"], -1)
        self.assertEqual(keyed["hollow"]["reasons"], ["unconverged"])
        self.assertEqual(keyed["variant"]["reasons"], ["electronic_method"])
        self.assertEqual(source["gas_references"][0]["box_lengths_angstrom"], [18, 19, 20])
        top = next(row for row in extra["runs"] if row["logical_id"] == "top")
        self.assertEqual(top["energy_eV"], -21.5)
        self.assertEqual(top["fractional_positions"][-1], [0.75, 0.75, 0.67])
        self.assertEqual(top["ionic_steps"], 2)
        self.assertEqual(top["parent_raw_id"], "raw-upload")
        self.assertAlmostEqual(source["clean_slab"]["convergence"]["max_free_force_eV_per_angstrom"], 0.008)

    def test_cell_cap_checks_every_role(self):
        for limits in ([50, 50, 19], {"c": 19}):
            with self.subTest(limits=limits), self.assertRaisesRegex(ValueError, "oxygen:.*20.0.*19.0.*c"):
                self.run_import(options={"cell_limits_A": limits})
        with self.assertRaisesRegex(ValueError, "at most 50"):
            self.run_import(options={"cell_limits_A": [51, 50, 50]})

    def test_invalid_and_untrusted_files(self):
        study, files = _study()
        with self.assertRaisesRegex(ValueError, "unsafe ZIP"):
            self.run_import(_bundle(study, dict(files, **{"../outside": b"test"})))
        bad = files["bulk/vasprun.xml"].replace(
            b"<modeling>", b'<!DOCTYPE modeling [<!ENTITY attack SYSTEM "file:///secret">]><modeling>')
        with self.assertRaisesRegex(ValueError, "DTD"):
            self.run_import(_bundle(study, dict(files, **{"bulk/vasprun.xml": bad})))
        with patch.dict("os.environ", {"CATALYSIS_VASP_XML_NODES": "20"}):
            with self.assertRaisesRegex(ValueError, "XML_NODES=20"):
                self.run_import()
        with patch.dict("os.environ", {"CATALYSIS_VASP_MEMBER_MIB": "1"}):
            with self.assertRaisesRegex(ValueError, "MEMBER_MIB=1"):
                self.run_import(_bundle(study, dict(files, **{"big": b"x" * (1024**2 + 1)})))
        del files[study["evidence"]["size"]]
        with self.assertRaisesRegex(ValueError, "supplementary files"):
            self.run_import(_bundle(study, files))

    def test_static_bulk_requires_documented_prior_relaxation(self):
        study, files = _study()
        files["bulk/vasprun.xml"] = files["bulk/vasprun.xml"].replace(b'>40</i>', b'>0</i>')
        with self.assertRaisesRegex(ValueError, "Static XML requires"):
            self.run_import(_bundle(study, files))
        study["bulk"]["geometry_history"] = "restart_from_relaxed"
        with self.assertRaisesRegex(ValueError, "prior_relaxation_evidence_id"):
            self.run_import(_bundle(study, files))

    def test_fixed_cell_requires_matching_ordered_vectors(self):
        study, files = _study()
        path = "top/vasprun.xml"
        files[path] = files[path].replace(b"<v>6 0 0</v>", b"<v>6.001 0 0</v>")
        with self.assertRaisesRegex(ValueError, "top.*same ordered lattice vectors"):
            self.run_import(_bundle(study, files))

    def test_missing_scf_fields_need_supplementary_measured_residual(self):
        study, files = _study()
        path = "top/vasprun.xml"
        files[path] = files[path].replace(b'name="e_wo_entrp"', b'name="eigenvalues"')
        with self.assertRaisesRegex(ValueError, "full-precision protocol evidence"):
            self.run_import(_bundle(study, files))
        top = study["configurations"][0]
        top["scf_residual_eV"] = 2e-7
        files[study["evidence"][top["protocol_evidence_id"]]] = json.dumps(
            {"synthetic": True, "full_precision_scf_delta_eV": 2e-7}).encode()
        source, _, extra, _ = self.run_import(_bundle(study, files))
        detail = next(row for row in extra["runs"] if row["logical_id"] == "top")
        self.assertEqual(detail["scf_residual_source"], "protocol evidence")
        self.assertEqual(source["configurations"][0]["convergence"]["evidence_id"],
                         extra["evidence"][top["protocol_evidence_id"]]["blob_id"])
