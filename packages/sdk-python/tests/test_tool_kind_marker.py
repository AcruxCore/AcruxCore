"""Issue #870, layer 3 — a developer can mark a tool as a search, or as not a search.

``@acrux.tool(kind="retrieval")`` and ``kind="tool"`` reach the platform as the span
attribute ``toolKind``; the trace view reads it before guessing from the output's shape.
The tests read the spans the SDK actually POSTs, as ``test_tool_failure`` does.
"""

from __future__ import annotations

from typing import Any, List

import httpx
import pytest

from acruxcore import acrux
from acruxcore.errors import ToolSchemaError

from test_tool_failure import make_client, tool_spans

pytestmark = pytest.mark.asyncio


async def _run(client: Any, **kwargs: Any) -> None:
    await client.gateway.run_tool_loop(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Weather in Atlantis?"}],
        **kwargs,
    )
    await client.gateway.flush()


async def test_kind_retrieval_is_written_as_the_tool_kind_attribute() -> None:
    @acrux.tool(kind="retrieval")
    def get_weather(city: str) -> str:
        """Search the weather notes."""
        return "Doc 1: Atlantis is underwater."

    sent: List[httpx.Request] = []
    async with make_client(sent) as client:
        await _run(client, tools=[get_weather], sync=False)

    spans = tool_spans(sent)
    assert len(spans) == 1
    # The span stays a `tool` span: analytics, failure handling and filters see no change.
    assert spans[0]["kind"] == "tool"
    assert spans[0]["attributes"]["toolKind"] == "retrieval"


async def test_kind_tool_is_written_so_detection_can_be_turned_off() -> None:
    @acrux.tool(kind="tool")
    def get_weather(city: str) -> list:
        """Weather readings."""
        return [{"text": "Sunny"}]

    sent: List[httpx.Request] = []
    async with make_client(sent) as client:
        await _run(client, tools=[get_weather], sync=False)

    assert tool_spans(sent)[0]["attributes"]["toolKind"] == "tool"


async def test_a_decorated_function_in_client_tools_carries_its_marker() -> None:
    @acrux.tool(kind="retrieval")
    def get_weather(city: str) -> str:
        """Search the weather notes."""
        return "Doc 1: Atlantis is underwater."

    sent: List[httpx.Request] = []
    async with make_client(sent) as client:
        await _run(client, tool_refs=[{"name": "get_weather"}], client_tools={"get_weather": get_weather})

    assert tool_spans(sent)[0]["attributes"]["toolKind"] == "retrieval"


async def test_an_unmarked_tool_sends_no_tool_kind() -> None:
    @acrux.tool
    def get_weather(city: str) -> str:
        """Weather."""
        return "Sunny"

    sent: List[httpx.Request] = []
    async with make_client(sent) as client:
        await _run(client, tools=[get_weather], sync=False)

    assert "toolKind" not in tool_spans(sent)[0]["attributes"]


@pytest.mark.filterwarnings("ignore")
def test_an_unknown_kind_is_rejected_at_decoration_time() -> None:
    with pytest.raises(ToolSchemaError, match="kind"):

        @acrux.tool(kind="search")  # type: ignore[arg-type]
        def get_weather(city: str) -> str:
            """Weather."""
            return "Sunny"
