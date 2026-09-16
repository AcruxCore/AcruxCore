"""A mid-stream error frame must raise, not end the stream quietly.

When a streamed completion fails after its first byte has gone out, the gateway can
no longer answer with a status code — the headers are already sent. It writes an SSE
frame carrying ``error`` instead, then ``[DONE]``. The parser used to read that frame
as ``choices or [{}]``, yield one empty chunk, and then treat ``[DONE]`` as a clean
finish: a truncated answer reported to the caller as a complete one.

Every test drives the real client through a mocked httpx transport, so the assertions
are about what the SDK does with real wire bytes.
"""

from __future__ import annotations

import json
from typing import Callable, List

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError

pytestmark = pytest.mark.asyncio


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> AcruxCore:
    return AcruxCore(
        api_key="k",
        base_url="http://localhost:3001/api/v1",
        transport=httpx.MockTransport(handler),
    )


def sse(*frames: str) -> httpx.Response:
    return httpx.Response(
        200,
        content="".join(frames).encode(),
        headers={"content-type": "text/event-stream"},
    )


def chunk(text: str) -> str:
    payload = {
        "id": "cmpl-1",
        "model": "gpt-4o-mini",
        "choices": [{"delta": {"content": text}, "finish_reason": None}],
    }
    return f"data: {json.dumps(payload)}\n\n"


ERROR_FRAME = (
    'data: {"error":{"code":"NOT_FOUND","message":"Budget not found."}}\n\n'
)


async def test_error_frame_raises_instead_of_ending_quietly() -> None:
    hub = make_client(lambda _req: sse(chunk("Hel"), ERROR_FRAME, "data: [DONE]\n\n"))
    received: List[str] = []

    with pytest.raises(AcruxCoreError) as excinfo:
        async for c in await hub.gateway.chat(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
        ):
            if c.delta.get("content"):
                received.append(c.delta["content"])

    assert excinfo.value.code == "API_ERROR"
    assert "Budget not found." in str(excinfo.value)
    assert excinfo.value.body["error"]["code"] == "NOT_FOUND"
    # The text delivered before the failure still reached the caller.
    assert received == ["Hel"]
    await hub.gateway.aclose()


async def test_clean_stream_is_unaffected() -> None:
    hub = make_client(
        lambda _req: sse(chunk("Hello"), chunk(" there"), "data: [DONE]\n\n")
    )
    received: List[str] = []

    async for c in await hub.gateway.chat(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
    ):
        if c.delta.get("content"):
            received.append(c.delta["content"])

    assert "".join(received) == "Hello there"
    await hub.gateway.aclose()
