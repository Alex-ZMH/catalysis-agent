"""Evaluate the four geometries of a basal-site batch at identical coordinates."""
import json
import sys
import numpy as np
from tblite.interface import Calculator

bohr = 0.529177210903
hartree = 27.211386245988
numbers = {"Mo": 42, "S": 16, "H": 1}
models = json.load(sys.stdin)
energies = {}
for name in ("clean", "A", "B", "H2"):
    model = models[name]
    cell = np.asarray(model["cell"]) / bohr
    atoms = model["atoms"]
    positions = np.asarray([a["fractional"] for a in atoms]) @ cell
    atomic_numbers = np.asarray([numbers[a["element"]] for a in atoms], dtype=int)
    kwargs = {"uhf": int(atomic_numbers.sum() % 2)}
    if name != "H2":
        kwargs.update(lattice=cell, periodic=np.array([True, True, True]))
    calc = Calculator("GFN1-xTB", atomic_numbers, positions, **kwargs)
    calc.set("verbosity", 0)
    calc.set("max-iter", 400)
    val = float(calc.singlepoint().get("energy")) * hartree
    if not np.isfinite(val):
        raise ValueError("Non-finite electronic energy")
    energies[name] = val
print(json.dumps(energies, allow_nan=False))
