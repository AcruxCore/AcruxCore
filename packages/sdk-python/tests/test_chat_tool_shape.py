"""``gateway.chat`` rejects a function declared with ``@acrux.tool``.

``chat()`` and ``run_tool_loop()`` both take ``tools``, and they mean different things
by it: raw OpenAI definitions here, decorated functions there. The wrong one used to die
inside ``json.dumps`` as ``Object of type function is not JSON serializable``, which
names neither the argument nor the call that would have run it.

Every test drives the real client through a mocked httpx transport, so "nothing was
sent" is an assertion about the transport, not about a stub.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError, acrux

pytestmark = pytest.mark.asyncio


@acrux.tool
async def roll_die(sides: int) -> dict:
    """Roll an N-sided die.

    Args:
        sides: Number of sides.
    """
    return {"value": 4}


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> AcruxCore:
    """A client wired to a mock transport, pointed at a loopback base_url."""
    return AcruxCore(
        api_key="k",
        base_url="http://localhost:3001/api/v1",
        transport=httpx.MockTransport(handler),
    )


async def test_declared_tool_raises_tool_schema_error() -> None:
    """The error names the tool and the call that does run it."""
    sent: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={})

    hub = make_client(handler)
    with pytest.raises(AcruxCoreError) as excinfo:
        await hub.gateway.chat(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "hi"}],
            tools=[roll_die],
        )

    assert excinfo.value.code == "TOOL_SCHEMA_ERROR"
    assert "'roll_die'" in str(excinfo.value)
    assert "run_tool_loop" in str(excinfo.value)
    # Nothing reached the wire — the shape is caught before the request is built.
    assert sent == []
    await hub.gateway.aclose()


async def test_raw_definitions_still_pass_through() -> None:
    """A raw OpenAI definition is unaffected and travels in the request body."""
    bodies: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "model": "gpt-4o-mini",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "Sunny."}, "finish_reason": "stop"}
                ],
            },
        )

    hub = make_client(handler)
    result = await hub.gateway.chat(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        tools=[
            {
                "type": "function",
                "function": {"name": "get_weather", "description": "Weather.", "parameters": {"type": "object", "properties": {}}},
            }
        ],
    )

    assert result.message["content"] == "Sunny."
    assert bodies[0]["tools"][0]["function"]["name"] == "get_weather"
    await hub.gateway.aclose()
