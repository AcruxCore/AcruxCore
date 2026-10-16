"""``reasoning_effort`` reaches the model, and the provider's cached and reasoning token
counts reach the caller and the trace (issues #593, #594).

A BYO span that left out ``cachedTokens`` was billed with every prompt token at the full
input rate, so the span ``usage`` posted to ``/traces`` is asserted exactly.

Every test drives the real client through a mocked httpx transport — no network.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

from acruxcore import AcruxCore
from acruxcore.types import ChatUsage, RenderResult

pytestmark = pytest.mark.asyncio

PROVIDER = {"base_url": "https://provider.invalid/v1", "api_key": "pk"}

NESTED_USAGE: Dict[str, Any] = {
    "prompt_tokens": 1200,
    "completion_tokens": 300,
    "total_tokens": 1500,
    "prompt_tokens_details": {"cached_tokens": 1024},
    "completion_tokens_details": {"reasoning_tokens": 256},
}

SPAN_USAGE = {"promptTokens": 1200, "completionTokens": 300, "totalTokens": 1500, "cachedTokens": 1024}


def completion(usage: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": "c1",
        "model": "stub-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
        "usage": usage,
    }


def sse(usage: Dict[str, Any]) -> bytes:
    frames = [
        {"id": "s1", "model": "stub-model", "choices": [{"index": 0, "delta": {"content": "po"}, "finish_reason": None}]},
        {"id": "s1", "model": "stub-model", "choices": [{"index": 0, "delta": {"content": "ng"}, "finish_reason": "stop"}]},
        {"id": "s1", "model": "stub-model", "choices": [], "usage": usage},
    ]
    return ("".join(f"data: {json.dumps(f)}\n\n" for f in frames) + "data: [DONE]\n\n").encode()


class Recorder:
    """Stands in for both the platform API and the BYO provider, recording both sides."""

    def __init__(self, *, usage: Optional[Dict[str, Any]] = None, stream: bool = False) -> None:
        self.usage = usage if usage is not None else NESTED_USAGE
        self.stream = stream
        self.provider_bodies: List[Dict[str, Any]] = []
        self.gateway_bodies: List[Dict[str, Any]] = []
        self.spans: List[Dict[str, Any]] = []

    def handler(self) -> Callable[[httpx.Request], httpx.Response]:
        def handle(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            body = json.loads(request.content) if request.content else {}
            if path.endswith("/traces"):
                for t in body["traces"]:
                    self.spans.extend(t["spans"])
                return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})
            if request.url.host == "provider.invalid":
                self.provider_bodies.append(body)
                if self.stream:
                    return httpx.Response(200, content=sse(self.usage), headers={"content-type": "text/event-stream"})
                return httpx.Response(200, json=completion(self.usage))
            if path.endswith("/gateway/chat/completions"):
                self.gateway_bodies.append(body)
                return httpx.Response(200, json=completion(self.usage))
            return httpx.Response(404, json={"error": {"message": f"unexpected {path}"}})

        return handle


def make_client(rec: Recorder) -> AcruxCore:
    return AcruxCore(
        api_key="k",
        base_url="http://localhost:3001/api/v1",
        transport=httpx.MockTransport(rec.handler()),
    )


def llm_spans(rec: Recorder) -> List[Dict[str, Any]]:
    return [s for s in rec.spans if s.get("kind") == "llm"]


async def test_gateway_chat_sends_reasoning_effort_and_reads_flat_counts() -> None:
    rec = Recorder(usage={
        "prompt_tokens": 1200, "completion_tokens": 300, "total_tokens": 1500,
        "cached_tokens": 1024, "reasoning_tokens": 256,
    })
    async with make_client(rec) as hub:
        result = await hub.gateway.chat("o4-mini", [{"role": "user", "content": "hi"}], reasoning_effort="high")

    assert rec.gateway_bodies[0]["reasoning_effort"] == "high"
    assert result.usage == ChatUsage(
        prompt_tokens=1200, completion_tokens=300, total_tokens=1500, cached_tokens=1024, reasoning_tokens=256,
    )


async def test_byo_chat_sends_reasoning_effort_reads_nested_counts_and_reports_cached_tokens() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        result = await hub.gateway.chat(
            "o4-mini", [{"role": "user", "content": "hi"}], reasoning_effort="low", provider=PROVIDER,
        )
        await hub.gateway.flush()

    assert rec.provider_bodies[0]["reasoning_effort"] == "low"
    assert result.usage == ChatUsage(
        prompt_tokens=1200, completion_tokens=300, total_tokens=1500, cached_tokens=1024, reasoning_tokens=256,
    )
    assert [s["usage"] for s in llm_spans(rec)] == [SPAN_USAGE]


async def test_zero_counts_are_omitted_and_no_reasoning_effort_unless_asked() -> None:
    rec = Recorder(usage={
        "prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12,
        "prompt_tokens_details": {"cached_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 0},
    })
    async with make_client(rec) as hub:
        result = await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], provider=PROVIDER)
        await hub.gateway.flush()

    assert "reasoning_effort" not in rec.provider_bodies[0]
    assert result.usage == ChatUsage(prompt_tokens=10, completion_tokens=2, total_tokens=12)
    assert [s["usage"] for s in llm_spans(rec)] == [{"promptTokens": 10, "completionTokens": 2, "totalTokens": 12}]


async def test_byo_stream_sends_reasoning_effort_and_reports_cached_tokens() -> None:
    rec = Recorder(stream=True)
    async with make_client(rec) as hub:
        stream = await hub.gateway.stream(
            "o4-mini", [{"role": "user", "content": "hi"}], reasoning_effort="medium", provider=PROVIDER,
        )
        text = ""
        async for chunk in stream:
            text += (chunk.delta or {}).get("content") or ""
        await hub.gateway.flush()

    assert text == "pong"
    assert rec.provider_bodies[0]["reasoning_effort"] == "medium"
    assert [s["usage"] for s in llm_spans(rec)] == [SPAN_USAGE]


async def test_byo_run_tool_loop_sends_reasoning_effort_and_reports_cached_tokens() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        await hub.gateway.run_tool_loop(
            "o4-mini", [{"role": "user", "content": "hi"}], reasoning_effort="high", provider=PROVIDER,
        )
        await hub.gateway.flush()

    assert rec.provider_bodies[0]["reasoning_effort"] == "high"
    assert [s["usage"] for s in llm_spans(rec)] == [SPAN_USAGE]


async def test_byo_streaming_run_tool_loop_sends_reasoning_effort_and_reports_cached_tokens() -> None:
    rec = Recorder(stream=True)
    async with make_client(rec) as hub:
        events = await hub.gateway.run_tool_loop(
            "o4-mini", [{"role": "user", "content": "hi"}], reasoning_effort="low", provider=PROVIDER, stream=True,
        )
        async for _ in events:
            pass
        await hub.gateway.flush()

    assert rec.provider_bodies[0]["reasoning_effort"] == "low"
    assert [s["usage"] for s in llm_spans(rec)] == [SPAN_USAGE]


async def test_run_prompt_with_tools_passes_reasoning_effort_to_the_gateway() -> None:
    rec = Recorder()
    rendered = RenderResult(messages=[{"role": "user", "content": "hi"}], model="o4-mini")
    async with make_client(rec) as hub:
        await hub.gateway.run_prompt_with_tools(rendered, reasoning_effort="high")

    assert rec.gateway_bodies[0]["reasoning_effort"] == "high"


async def test_cached_count_larger_than_prompt_count_is_dropped_from_the_span() -> None:
    rec = Recorder(usage={
        "prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12,
        "prompt_tokens_details": {"cached_tokens": 50},
    })
    async with make_client(rec) as hub:
        await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], provider=PROVIDER)
        await hub.gateway.flush()

    assert [s["usage"] for s in llm_spans(rec)] == [{"promptTokens": 10, "completionTokens": 2, "totalTokens": 12}]
