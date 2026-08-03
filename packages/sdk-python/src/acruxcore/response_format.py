"""Build a ``response_format`` from a pydantic model — the typed alternative to the dict.

The SDK's :data:`~acruxcore.types.ResponseFormat` is the OpenAI-shaped dict the gateway
forwards straight to the provider. This module offers a typed way to produce that same
dict from a pydantic v2 ``BaseModel`` subclass, so field-level ``Field(description=...)``
guidance reaches the model without hand-writing JSON Schema. Pydantic is an *optional*
dependency — it is imported lazily only when a pydantic-built format is actually sent, and
:func:`pydantic_response_format` itself does not import it (the import happens at send time
in :func:`normalize_response_format`).
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Type

from .errors import PYDANTIC_NOT_AVAILABLE, AcruxCoreError

#: Sentinel key marking a dict as "build me from a pydantic model at send time". A private
#: contract between :func:`pydantic_response_format` and :func:`normalize_response_format`;
#: callers build these only via the helper.
_PYDANTIC_SENTINEL = "__acruxcore_pydantic_response_format__"


def pydantic_response_format(
    model: Type[Any],
    *,
    name: str,
    strict: bool = True,
) -> Dict[str, Any]:
    """Build a ``response_format`` from a pydantic v2 ``BaseModel`` subclass.

    Returns a marker dict the SDK resolves to the OpenAI-shaped wire format when the
    request is sent (calling ``model.model_json_schema()``). Pydantic itself is imported
    only at that point, so this call never requires pydantic to be installed.

    :param model: A pydantic v2 ``BaseModel`` subclass (the class itself, not an instance).
    :param name: The OpenAI ``json_schema.name`` for the request — required, since a class
        name is an API contract on the gateway, not a label the SDK should guess. Lowercase
        snake_case is conventional (e.g. ``"medical_information_answer"``).
    :param strict: Whether to ask the provider for strict schema adherence (default
        ``True``). Maps to ``json_schema.strict``.
    :returns: An opaque marker dict; pass it as ``response_format=`` to
        :meth:`~acruxcore.client.AcruxCore.chat` or
        :meth:`~acruxcore.client.AcruxCore.run_tool_loop`.
    """
    if not isinstance(model, type):
        raise AcruxCoreError(
            "acruxcore: pydantic_response_format() takes a BaseModel subclass (the class "
            f"itself), received an instance of {type(model).__name__}.",
            "TOOL_SCHEMA_ERROR",
        )
    if not name or not isinstance(name, str):
        raise AcruxCoreError(
            "acruxcore: pydantic_response_format() requires a non-empty `name` for the "
            "gateway's json_schema.name field.",
            "TOOL_SCHEMA_ERROR",
        )
    return {_PYDANTIC_SENTINEL: model, "name": name, "strict": strict}


def is_pydantic_response_format(value: Any) -> bool:
    """True when ``value`` is a marker dict from :func:`pydantic_response_format`."""
    return (
        isinstance(value, dict)
        and _PYDANTIC_SENTINEL in value
        and isinstance(value[_PYDANTIC_SENTINEL], type)
    )


def normalize_response_format(
    response_format: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Resolve a ``response_format`` to the OpenAI-shaped wire dict.

    A pydantic-built marker dict (from :func:`pydantic_response_format`) is converted by
    importing pydantic lazily and calling ``model_json_schema()``; anything else is passed
    through unchanged. Returns ``None`` when ``response_format`` is ``None``.

    :raises AcruxCoreError: ``PYDANTIC_NOT_AVAILABLE`` if a pydantic-built format was given
        but pydantic is not installed.
    """
    if response_format is None:
        return None
    if not is_pydantic_response_format(response_format):
        return response_format

    model: Type[Any] = response_format[_PYDANTIC_SENTINEL]
    try:
        schema = model.model_json_schema()
    except AttributeError:
        raise AcruxCoreError(
            "acruxcore: the class passed to pydantic_response_format() has no "
            "model_json_schema() — it is not a pydantic v2 BaseModel subclass. "
            f"Got {model.__name__ if isinstance(model, type) else type(model).__name__}.",
            "TOOL_SCHEMA_ERROR",
        )
    except ImportError as exc:
        raise AcruxCoreError(
            "acruxcore: a pydantic-built response_format was given but pydantic could not "
            f"be imported ({exc}). Install pydantic (>=2) alongside the SDK, or pass a "
            "plain JSON Schema dict as response_format instead.",
            PYDANTIC_NOT_AVAILABLE,
        )

    strict = response_format.get("strict", True)
    # pydantic's model_json_schema() does not emit the keys OpenAI's strict mode requires
    # (`additionalProperties: false` on every object) and emits `title` keys it rejects.
    # Normalize when strict is set so the default actually works against OpenAI; leave the
    # schema untouched when the caller opted out of strict (Anthropic/Gemini are lenient).
    if strict:
        schema = _strict_for_openai(schema)

    return {
        "type": "json_schema",
        "json_schema": {
            "name": response_format["name"],
            "schema": schema,
            "strict": strict,
        },
    }


def _strict_for_openai(node: Any) -> Any:
    """Make a pydantic JSON Schema acceptable to OpenAI's strict `response_format`.

    OpenAI rejects a `strict: true` schema unless every object sets
    ``additionalProperties: false``; it also rejects the ``title`` keys pydantic adds to
    every field and the top level. A pydantic ``BaseModel`` is always a closed object, so
    adding ``additionalProperties: false`` is faithful, not a behavior change. Walks the
    schema recursively (objects, arrays, ``$defs``, ``allOf``/``anyOf``/``oneOf``).
    """
    if isinstance(node, list):
        return [_strict_for_openai(n) for n in node]
    if not isinstance(node, dict):
        return node
    cleaned = {k: _strict_for_openai(v) for k, v in node.items() if k != "title"}
    # `title` is the only key OpenAI strict mode rejects that pydantic always adds; keys
    # like `description` / `default` / `$defs` are fine and left in place.
    if cleaned.get("type") == "object" and "additionalProperties" not in cleaned:
        cleaned["additionalProperties"] = False
    return cleaned
