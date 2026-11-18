"""Shared semantic checks for the v1 science contracts."""

from jsonschema import ValidationError

from packages.contracts import validate_schema


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def validate_payload(filename, instance):
    """Apply the structural schema and reject integers outside float range."""
    validate_schema(filename, instance)
    pending = [instance]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, int):
            try:
                float(value)
            except OverflowError as error:
                raise ValidationError("Integer exceeds float range") from error
