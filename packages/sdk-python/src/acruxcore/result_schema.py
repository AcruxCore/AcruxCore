"""A deliberately small JSON Schema checker, used to decide whether a tool's result
matches the shape its owner declared.

**Why not a real validator.** This SDK ships with a minimal dependency set, and adding a
JSON Schema library to answer "does this object have the keys it promised" would be a
large cost for a small question. The subset below covers what a tool result schema
actually uses; anything outside it is ignored rather than rejected, so an unsupported
keyword can never manufacture a false failure — which matters because a mismatch is
reported to the operator, and a check that cries wolf gets switched off.

Kept behaviourally identical to ``apps/api/src/tools/execute/result-schema.ts`` and its
TypeScript SDK twin. The platform applies it to an ``http`` tool and this copy applies it
to a client-side one; if the three disagreed, the same tool would pass or fail depending
on who happened to run it.

**Supported:** ``type`` (including a union list), ``required``, ``properties``,
``items``, ``enum``, ``nullable``. Composition keywords (``anyOf``, ``allOf``, ``$ref``),
numeric and string bounds, and ``additionalProperties`` are all ignored on purpose.
"""

import json
from typing import Any, Optional

__all__ = ["validate_against_schema"]


def _type_of(value: Any) -> str:
    """JSON Schema's type names, as they map onto Python runtime values."""
    if value is None:
        return "null"
    # bool before int: in Python a bool IS an int, and reporting True as an integer
    # would let a schema demanding a number silently accept a flag.
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, list):
        return "array"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _matches_type(value: Any, declared: str) -> bool:
    """Whether a runtime value satisfies one declared ``type`` name."""
    actual = _type_of(value)
    # An integer is a number; the reverse is not true.
    if declared == "number":
        return actual in ("number", "integer")
    return actual == declared


def validate_against_schema(value: Any, schema: Any, path: str = "result") -> Optional[str]:
    """Check a value against a schema, returning the first thing that does not match.

    One message rather than a list: it is read in a span attribute and in a filter chip,
    where the first concrete mismatch ("missing required property 'temperature'") is more
    use than an exhaustive report nobody scrolls.

    :param value: The tool result.
    :param schema: The declared result schema, as a plain dict.
    :param path: Dotted path used to build the message; callers pass nothing.
    :returns: ``None`` when the value matches, otherwise a one-line readable reason.
    """
    if not isinstance(schema, dict):
        return None

    if value is None and schema.get("nullable"):
        return None

    declared_type = schema.get("type")
    if declared_type is not None:
        declared = declared_type if isinstance(declared_type, list) else [declared_type]
        if not any(_matches_type(value, t) for t in declared):
            return f"{path} should be {' or '.join(declared)}, got {_type_of(value)}"

    if "enum" in schema and value not in schema["enum"]:
        allowed = ", ".join(json.dumps(v) for v in schema["enum"])
        return f"{path} should be one of {allowed}"

    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(value):
            failure = validate_against_schema(item, schema["items"], f"{path}[{i}]")
            if failure:
                return failure
        return None

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                return f"{path} is missing required property '{key}'"
        for key, sub in (schema.get("properties") or {}).items():
            if key in value:
                failure = validate_against_schema(value[key], sub, f"{path}.{key}")
                if failure:
                    return failure

    return None
