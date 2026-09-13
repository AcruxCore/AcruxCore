"""How a tool tells the platform that a call went wrong, when only the tool can know.

An HTTP 200 carrying ``{"error": "location not found"}`` is a successful request and a
failed tool call, and nothing outside the tool's own code can tell those apart. Before
this existed, such a call produced a green span and the model answered on top of the
error body — the whole of issue #452.

Two alternatives were rejected. Injecting a context argument into the handler would
change its signature, and :func:`acruxcore.tooling.derive_parameters_schema` builds the
tool's model-facing schema by walking ``inspect.signature(fn)`` — so a ``ctx`` parameter
would be advertised to the model as something to fill in. A dedicated non-fatal exception
ends control flow, which is exactly what a tool reporting a *handled* failure does not
want: it still has something to hand back.

The sentinel is inert to anyone who ignores it. A handler that returns a plain value
behaves exactly as before.
"""

from dataclasses import dataclass
from typing import Any, Optional

__all__ = ["ToolResult"]

#: Sentinel distinguishing "no result argument was passed" from an explicit ``None``.
_UNSET = object()


@dataclass(frozen=True)
class ToolResult:
    """A tool's own verdict on its call, returned alongside what the model should see.

    Build one with :meth:`error` or :meth:`warn` rather than the constructor — the two
    classmethods are the documented surface and they fill in a sensible ``result``.

    :param level: ``'error'`` (the call failed) or ``'warning'`` (worth seeing, not a
        failure).
    :param type: Short stable slug, e.g. ``location_not_found``. Becomes the span's
        error detail, and is what you filter on.
    :param message: Human-readable detail, shown on the span.
    :param result: What the model still sees. The loop hands this to the model exactly
        as if it had been returned directly.
    """

    level: str
    type: str
    message: str
    result: Any = None

    @classmethod
    def error(cls, type: str, message: str, result: Any = _UNSET) -> "ToolResult":
        """Mark this call a failure while still returning something to the model.

        The span turns red with ``errorType: 'tool_declared'`` and the loop keeps
        going — whether a failed tool stops your agent is your decision, not ours.

        :param type: Short stable slug identifying the failure.
        :param message: Human-readable detail, shown on the span.
        :param result: What to hand the model. Defaults to ``{"error": message}``.
        :returns: A sentinel the tool loop unwraps; harmless anywhere else.
        """
        return cls(
            level="error",
            type=type,
            message=message,
            result={"error": message} if result is _UNSET else result,
        )

    @classmethod
    def warn(cls, type: str, message: str, result: Any = _UNSET) -> "ToolResult":
        """Flag something worth seeing without calling the run failed.

        Stale cache, a partial result, a fallback data source. The span stays ``ok`` and
        gains a ``warning`` attribute, which the ``has_warning:`` filter selects on.
        Deliberately not a span status: a warning is not a verdict about whether the run
        succeeded.

        :param type: Short stable slug, e.g. ``stale_data``.
        :param message: Human-readable detail, shown on the span.
        :param result: What to hand the model. Defaults to ``{"warning": message}``.
        :returns: A sentinel the tool loop unwraps; harmless anywhere else.
        """
        return cls(
            level="warning",
            type=type,
            message=message,
            result={"warning": message} if result is _UNSET else result,
        )


def unwrap(value: Any) -> Optional[ToolResult]:
    """Return ``value`` as a :class:`ToolResult`, or ``None`` when it is a plain result."""
    return value if isinstance(value, ToolResult) else None
