"""Write invented input files for the browser walkthrough into a new external folder."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]
from test_fit_import import demo as csv_demo, demo_xlsx
from test_vasp_import import demo as vasp_demo


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    out = parser.parse_args().directory.resolve()
    if any((p / ".git").exists() for p in (out, *out.parents)):
        parser.error("Choose a directory outside Git")
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        parser.error("Choose a new or empty directory")
    cases = {}
    for key, factory in (("vasp", vasp_demo), ("csv", csv_demo), ("xlsx", demo_xlsx)):
        filename, content, options = factory()
        (out / filename).write_bytes(content)
        cases[key] = dict(filename=filename, options=options)
    (out / "POSCAR").write_text(
        "Synthetic cleaved slab for dimension checks\n1\n18 0 0\n0 16 0\n0 0 32\n"
        "Si\n2\nSelective dynamics\nDirect\n0 0 0.375 F F F\n0.5 0.5 0.625 T T T\n",
        encoding="utf-8")
    (out / "cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
