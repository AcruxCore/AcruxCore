"""The ``@acrux.tool`` decorator: a function is the single source of a tool's interface.

The decorator is **pure**. It performs no network calls and has no import-time side
effects — it derives the name, description and parameter schema from the function and
attaches them as ``fn.__acrux_tool__``. Registration with the catalog is a separate,
explicit act (:meth:`AcruxCore.tools.sync`, or the first call of a tool loop).

That separation is deliberate. A decorator that registered at import time would make
importing a module hit the network, break offline test collection, and fire during
``--help``.
"""

from __future__ import annotations

import enum
import inspect
from dataclasses import dataclass
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Literal,
    Optional,
    Tuple,
    get_args,
    get_origin,
    get_type_hints,
)

from .errors import ToolSchemaError

#: Attribute the decorator attaches to the wrapped function.
SPEC_ATTRIBUTE = "__acrux_tool__"

#: Python scalar types that map straight onto a JSON Schema type.
_PRIMITIVES: Dict[Any, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
}


@dataclass
class ToolSpec:
    """A tool's complete interface, derived from the function that implements it.

    :param name: The function name the model calls.
    :param description: What the tool does, from the docstring's first paragraph.
        ``None`` when the function has no docstring — the catalog then keeps whatever
        description the dashboard holds, rather than clearing it.
    :param parameters_schema: JSON Schema object for the callable arguments.
    :param executor: Always ``{"type": "client"}``. A decorator wraps a Python
        function, so the caller's process is by definition what runs it; ``http``
        executors are a dashboard/API concern.
    :param alias: Which catalog alias a sync should move. Defaults to ``production``.
    :param changelog: Release note for humans. Never shown to the model.
    :param fn: The undecorated function, called when the model requests this tool.
    """

    name: str
    description: Optional[str]
    parameters_schema: Dict[str, Any]
    executor: Dict[str, Any]
    alias: str
    changelog: Optional[str]
    fn: Callable[..., Any]


def spec_of(obj: Any) -> Optional[ToolSpec]:
    """Return the :class:`ToolSpec` attached to ``obj``, or ``None``.

    Used by the tool loop to tell a decorated function apart from a raw OpenAI dict
    without asking the caller to declare which is which.

    :param obj: Anything. A non-callable, or a callable that was never decorated,
        yields ``None``.
    :returns: The attached spec, or ``None``.
    """
    spec = getattr(obj, SPEC_ATTRIBUTE, None)
    return spec if isinstance(spec, ToolSpec) else None


def parse_docstring(doc: Optional[str]) -> Tuple[Optional[str], Dict[str, str]]:
    """Split a Google-style docstring into its summary and its ``Args:`` entries.

    Only Google style is supported, because that is what this repo's examples use and
    guessing between three conventions produces worse descriptions than supporting one.

    :param doc: A raw ``__doc__`` value, or ``None``.
    :returns: ``(summary, {param_name: description})``. The summary is the first
        paragraph with its line breaks collapsed to single spaces; it is ``None`` when
        the docstring is absent or blank.
    """
    if not doc or not doc.strip():
        return None, {}

    lines = inspect.cleandoc(doc).split("\n")

    summary_lines: List[str] = []
    index = 0
    while index < len(lines) and lines[index].strip() and not _is_args_header(lines[index]):
        summary_lines.append(lines[index].strip())
        index += 1
    summary = " ".join(summary_lines) or None

    # Find the Args: header anywhere after the summary.
    while index < len(lines) and not _is_args_header(lines[index]):
        index += 1
    if index >= len(lines):
        return summary, {}

    args: Dict[str, str] = {}
    current: Optional[str] = None
    for raw in lines[index + 1 :]:
        if not raw.strip():
            continue
        # A non-indented line ends the Args: block (the next section header).
        if not raw.startswith((" ", "\t")):
            break
        stripped = raw.strip()
        name, separator, rest = stripped.partition(":")
        # `name: text` starts a new entry only if `name` looks like a bare identifier —
        # otherwise it is a continuation line that happens to contain a colon.
        if separator and name.strip().isidentifier():
            current = name.strip()
            args[current] = rest.strip()
        elif current is not None:
            args[current] = f"{args[current]} {stripped}".strip()
    return summary, args


def _is_args_header(line: str) -> bool:
    """True for a Google-style ``Args:`` / ``Arguments:`` section header."""
    return line.strip().rstrip(":").lower() in ("args", "arguments")


def derive_parameters_schema(fn: Callable[..., Any]) -> Dict[str, Any]:
    """Build a JSON Schema object from a function's signature and docstring.

    A parameter without a default is ``required``. Each parameter's ``description``
    comes from the docstring's ``Args:`` block.

    Supported hints: ``str``, ``int``, ``float``, ``bool``, ``list[T]``, ``dict``,
    ``Optional[T]``, ``Literal[...]`` and :class:`enum.Enum` subclasses. Anything else
    raises, rather than guessing — a hand-rolled converter that silently emitted
    ``{"type": "object"}`` for an unrecognised class would hand the model a schema
    nobody wrote.

    On Python 3.9 the hints are evaluated at runtime, so write ``Optional[int]``
    rather than ``int | None`` in a tool signature.

    :param fn: The function to derive from.
    :returns: ``{"type": "object", "properties": {...}, "required": [...]}``, with
        ``required`` omitted entirely when no parameter needs it.
    :raises ToolSchemaError: A parameter has no type hint, uses ``*args``/``**kwargs``,
        or has a hint this converter cannot model.
    """
    signature = inspect.signature(fn)
    hints = _resolve_hints(fn)

    properties: Dict[str, Any] = {}
    required: List[str] = []
    _, arg_docs = parse_docstring(fn.__doc__)

    for name, parameter in signature.parameters.items():
        if name in ("self", "cls"):
            continue
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            raise ToolSchemaError(
                f"acruxcore: tool '{fn.__name__}' uses *args/**kwargs ('{name}'), which has no "
                "JSON Schema equivalent. Name each argument, or pass an explicit schema: "
                "@acrux.tool(parameters={...})."
            )
        if name not in hints:
            raise ToolSchemaError(
                f"acruxcore: parameter '{name}' of tool '{fn.__name__}' has no type hint, so its "
                "schema cannot be derived. Add one, or pass an explicit schema: "
                "@acrux.tool(parameters={...})."
            )

        schema = _schema_for(hints[name], fn.__name__, name)
        if arg_docs.get(name):
            schema = {**schema, "description": arg_docs[name]}
        properties[name] = schema
        if parameter.default is inspect.Parameter.empty:
            required.append(name)

    out: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        out["required"] = required
    return out


def _resolve_hints(fn: Callable[..., Any]) -> Dict[str, Any]:
    """Resolve a function's annotations to real types, naming the parameter on failure.

    ``get_type_hints`` fails for the whole function if a single annotation cannot be
    resolved, and its message names the missing symbol but not the parameter. Under
    ``from __future__ import annotations`` every annotation is a string, so a class
    defined inside another function is unreachable — a footgun worth an error that says
    which parameter and why.

    :param fn: The function whose annotations to resolve.
    :returns: ``{parameter_name: type}``.
    :raises ToolSchemaError: An annotation could not be resolved.
    """
    try:
        return get_type_hints(fn)
    except Exception as err:
        globalns = getattr(fn, "__globals__", {})
        unresolved: List[str] = []
        for parameter_name, annotation in getattr(fn, "__annotations__", {}).items():
            if parameter_name == "return" or not isinstance(annotation, str):
                continue
            try:
                eval(annotation, globalns)  # noqa: S307 — exactly what get_type_hints does
            except Exception:
                unresolved.append(parameter_name)
        named = ", ".join(f"'{n}'" for n in unresolved) or "one of its parameters"
        raise ToolSchemaError(
            f"acruxcore: could not resolve the type hint for {named} of tool '{fn.__name__}' — "
            f"{err}. A class defined inside another function is not reachable at runtime; move it "
            "to module level, or pass an explicit schema: @acrux.tool(parameters={...})."
        )


def _schema_for(hint: Any, fn_name: str, param_name: str) -> Dict[str, Any]:
    """Convert one type hint to a JSON Schema fragment, or raise naming the parameter."""
    try:
        if hint in _PRIMITIVES:
            return {"type": _PRIMITIVES[hint]}
    except TypeError:  # an unhashable hint cannot be a primitive
        pass

    origin = get_origin(hint)
    args = get_args(hint)

    # Literal[...] first: its args are VALUES, not types, so the Optional and list
    # branches below would misread them.
    if origin is Literal:
        member_types = {type(a) for a in args}
        if len(member_types) != 1 or member_types.pop() not in _PRIMITIVES:
            raise ToolSchemaError(_unsupported(hint, fn_name, param_name))
        return {"type": _PRIMITIVES[type(args[0])], "enum": list(args)}

    # Optional[T] / Union[T, None] → T. Optionality is carried by `required`, not by a
    # nullable type: OpenAI-compatible models handle an absent argument far more
    # reliably than a `["string","null"]` union.
    if origin is not None and type(None) in args:
        remaining = [a for a in args if a is not type(None)]
        if len(remaining) == 1:
            return _schema_for(remaining[0], fn_name, param_name)
        raise ToolSchemaError(_unsupported(hint, fn_name, param_name))

    if origin is list:
        if len(args) != 1:
            raise ToolSchemaError(_unsupported(hint, fn_name, param_name))
        return {"type": "array", "items": _schema_for(args[0], fn_name, param_name)}

    if hint is dict or origin is dict:
        # Deliberately shallow: a `dict` argument's value shapes are not constrained,
        # and inventing `additionalProperties` from Dict[str, int] would over-specify.
        return {"type": "object"}

    if hint is list:
        raise ToolSchemaError(
            f"acruxcore: parameter '{param_name}' of tool '{fn_name}' is a bare `list`. "
            "The model needs the item type — use list[str] (or List[str]), or pass an "
            "explicit schema: @acrux.tool(parameters={...})."
        )

    if inspect.isclass(hint) and issubclass(hint, enum.Enum):
        values = [member.value for member in hint]
        member_types = {type(v) for v in values}
        if len(member_types) != 1 or member_types.pop() not in _PRIMITIVES:
            raise ToolSchemaError(_unsupported(hint, fn_name, param_name))
        return {"type": _PRIMITIVES[type(values[0])], "enum": values}

    raise ToolSchemaError(_unsupported(hint, fn_name, param_name))


def _unsupported(hint: Any, fn_name: str, param_name: str) -> str:
    """The one error message every unsupported hint funnels into."""
    return (
        f"acruxcore: parameter '{param_name}' of tool '{fn_name}' has type {hint!r}, which cannot "
        "be converted to a JSON Schema. Supported hints are str, int, float, bool, list[T], dict, "
        "Optional[T], Literal[...] and Enum subclasses. For anything else, pass the schema by "
        "hand: @acrux.tool(parameters={...})."
    )


def tool(
    fn: Optional[Callable[..., Any]] = None,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    parameters: Optional[Dict[str, Any]] = None,
    alias: str = "production",
    changelog: Optional[str] = None,
) -> Any:
    """Mark a function as a tool, deriving its interface from the function itself.

    Works bare (``@acrux.tool``) and called (``@acrux.tool(alias="staging")``). The
    function is returned unchanged apart from an added ``__acrux_tool__`` attribute,
    so it stays directly callable and testable.

    ::

        @acrux.tool
        async def get_weather(city: str) -> dict:
            \"\"\"Get the current weather for a city.

            Args:
                city: City name, e.g. 'Lahore'.
            \"\"\"
            ...

    A function with **no docstring** sends no description, which hands ownership of the
    model-facing text to the dashboard: the catalog carries the existing description
    forward instead of clearing it. Write a docstring when the code should own that text.

    :param fn: The function, when used bare. Never pass this explicitly.
    :param name: Override the tool name. Defaults to the function's name.
    :param description: Override what the model reads. Defaults to the docstring's
        first paragraph.
    :param parameters: A hand-written JSON Schema object. Supplying it skips
        derivation entirely — the escape hatch for a type this converter cannot model.
    :param alias: Which catalog alias a sync moves. Defaults to ``production``.
    :param changelog: Release note for humans. Never shown to the model.
    :returns: The same function, with a :class:`ToolSpec` attached.
    :raises ToolSchemaError: At decoration time, when the schema cannot be derived.
    """

    def decorate(target: Callable[..., Any]) -> Callable[..., Any]:
        derived_description, _ = parse_docstring(target.__doc__)
        spec = ToolSpec(
            name=name or target.__name__,
            description=description if description is not None else derived_description,
            parameters_schema=(
                parameters if parameters is not None else derive_parameters_schema(target)
            ),
            executor={"type": "client"},
            alias=alias,
            changelog=changelog,
            fn=target,
        )
        setattr(target, SPEC_ATTRIBUTE, spec)
        return target

    return decorate if fn is None else decorate(fn)
