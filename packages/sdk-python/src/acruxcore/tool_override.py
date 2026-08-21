"""Per-call tool alias override, on top of a rendered prompt's own attachments."""

import warnings
from dataclasses import dataclass
from typing import List

from .types import RenderResult, ToolDefinition


@dataclass
class ToolOverrideResult:
    """What :func:`with_tool_override` hands back — spread both fields straight
    into :meth:`AcruxCore.gateway.chat`."""

    tools: List[ToolDefinition]
    tool_refs: List[dict]


def with_tool_override(rendered: RenderResult, *, name: str, alias: str) -> ToolOverrideResult:
    """Overrides one tool's resolution for a single ``gateway.chat()`` call, without
    touching the prompt's own binding.

    Sending the same tool name in both ``tools`` and ``tool_refs`` is a 400 from the
    gateway (two definitions, no tie-breaker) — this removes the tool from ``tools``
    first, then adds it to ``tool_refs`` under the alias you asked for. If the tool
    was already bound, it warns rather than silently swapping it, naming whatever
    the prompt currently has configured (from ``rendered.tool_resolutions``) so the
    override doesn't read as the prompt's own setting.

    This only affects this one call — the prompt's binding (its default, or the row
    this prompt alias owns) is unchanged either way. To change it for good, use
    :meth:`~acruxcore.prompts_api.PromptsNamespace.set_tool_binding` or
    :meth:`~acruxcore.prompts_api.PromptsNamespace.set_alias_tool_binding`.

    :param rendered: The result of ``prompts.render(...)``.
    :param name: The tool name to override.
    :param alias: The tool alias to use instead, for this call only.
    :returns: ``tools`` with the overridden name removed, and a ``tool_refs`` entry
        for it.
    """
    resolution = next((r for r in rendered.tool_resolutions if r.name == name), None)

    if resolution is not None:
        if resolution.alias is not None:
            current = resolution.alias
        elif resolution.pinned_version_number is not None:
            current = f"pinned to v{resolution.pinned_version_number}"
        else:
            current = "unknown"
        # Naming the layer matters when it is the prompt's default: that binding is
        # shared by every alias inheriting it, so changing it there is not a local edit.
        via = (
            " (the prompt's default binding)"
            if resolution.source == "default"
            else " (this prompt alias's own binding)"
        )
        warnings.warn(
            f'[acruxcore] Overriding "{name}" to alias "{alias}" for this call. '
            f'The prompt currently has this tool set to "{current}"{via} — '
            "that setting is unchanged. If this override should be permanent, "
            "change it there instead.",
            stacklevel=2,
        )

    return ToolOverrideResult(
        tools=[t for t in rendered.tools if t["function"]["name"] != name],
        tool_refs=[{"name": name, "alias": alias}],
    )
