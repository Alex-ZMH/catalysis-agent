"""Offline validation against the reviewed, repository-local v1 contracts."""
import json
import math
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry, Resource

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "contracts" / "v1"


@lru_cache
def _validators():
    schemas = {p.name: json.loads(p.read_text(encoding="utf-8"))
               for p in SCHEMA_DIR.glob("*.schema.json")}
    # An explicit registry has no remote retrieval callback.
    registry = Registry()
    for schema in schemas.values():
        Draft202012Validator.check_schema(schema)
        if "$id" in schema:
            registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return {name: Draft202012Validator(schema, registry=registry)
            for name, schema in schemas.items()}


def _check_finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValidationError("Expected a finite JSON number")
    if isinstance(value, dict):
        for item in value.values():
            _check_finite(item)
    elif isinstance(value, list):
        for item in value:
            _check_finite(item)


def validate_schema(filename, instance):
    """Raise ValidationError for invalid data. Only known filenames can be selected."""
    _check_finite(instance)
    _validators()[filename].validate(instance)
