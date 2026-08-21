"""Unit tests for with_tool_override — a pure function, no network needed."""

from __future__ import annotations

import pytest

from acruxcore import RenderResult, ToolResolution, with_tool_override


def _tool_def(name: str) -> dict:
    return {"type": "function", "function": {"name": name, "parameters": {"type": "object", "properties": {}}}}


def test_adds_a_not_yet_bound_tool_without_warning(recwarn):
    rendered = RenderResult(
        messages=[],
        tools=[_tool_def("get_weather")],
        tool_resolutions=[ToolResolution(name="get_weather", alias="production", version_number=3)],
    )

    result = with_tool_override(rendered, name="best_run_hour", alias="staging")

    assert result.tools == rendered.tools
    assert result.tool_refs == [{"name": "best_run_hour", "alias": "staging"}]
    assert len(recwarn) == 0


def test_removes_an_already_bound_tool_and_warns_with_its_current_alias():
    rendered = RenderResult(
        messages=[],
        tools=[_tool_def("get_weather"), _tool_def("best_run_hour")],
        tool_resolutions=[
            ToolResolution(name="get_weather", alias="production", version_number=3),
            ToolResolution(name="best_run_hour", alias="production", version_number=1),
        ],
    )

    with pytest.warns(UserWarning) as record:
        result = with_tool_override(rendered, name="get_weather", alias="staging")

    assert [t["function"]["name"] for t in result.tools] == ["best_run_hour"]
    assert result.tool_refs == [{"name": "get_weather", "alias": "staging"}]
    message = str(record[0].message)
    assert "get_weather" in message
    assert "staging" in message
    assert '"production"' in message


def test_names_the_prompt_default_when_the_default_decided_the_current_value():
    rendered = RenderResult(
        messages=[],
        tools=[_tool_def("get_weather")],
        tool_resolutions=[
            ToolResolution(name="get_weather", alias="dev", version_number=3, source="default")
        ],
    )

    with pytest.warns(UserWarning) as record:
        with_tool_override(rendered, name="get_weather", alias="staging")

    assert "the prompt's default binding" in str(record[0].message)


def test_names_the_alias_binding_when_the_prompt_alias_decided_the_current_value():
    rendered = RenderResult(
        messages=[],
        tools=[_tool_def("get_weather")],
        tool_resolutions=[
            ToolResolution(name="get_weather", alias="dev", version_number=3, source="alias")
        ],
    )

    with pytest.warns(UserWarning) as record:
        with_tool_override(rendered, name="get_weather", alias="staging")

    assert "this prompt alias's own binding" in str(record[0].message)


def test_mentions_the_pin_when_the_current_binding_is_pinned():
    rendered = RenderResult(
        messages=[],
        tools=[_tool_def("get_weather")],
        tool_resolutions=[ToolResolution(name="get_weather", pinned_version_number=2, version_number=2)],
    )

    with pytest.warns(UserWarning) as record:
        with_tool_override(rendered, name="get_weather", alias="staging")

    assert "pinned to v2" in str(record[0].message)
