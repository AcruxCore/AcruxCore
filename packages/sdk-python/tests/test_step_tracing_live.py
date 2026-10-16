"""Step tracing against a real ``apps/api`` server (PR #613 review findings).

``test_step_tracing.py`` proves what the SDK sends; this file proves the server stores
it. Each test reports a step tree, reads the trace back with ``traces.get`` and checks
every span arrived. Only the BYO model provider is faked — it is the one outbound call
to a paid third party — and the platform API is the real subprocess server from
``conftest.py``'s ``api_server`` fixture.

Run: ``REDIS_URL=redis://localhost:6379/13 pytest tests/test_step_tracing_live.py``
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore
from acruxcore.types import TraceSpan

from conftest import signup_and_mint_key

PROVIDER = {"base_url": "https://provider.invalid/v1", "api_key": "pk"}

LOOKUP_DEF = {"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}}}


def _reply(message: Dict[str, Any], finish_reason: str) -> Dict[str, Any]:
    return {
        "id": "c1", "model": "stub-model",
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6},
    }


class FakeProvider(httpx.AsyncBaseTransport):
    """Answers ``provider.invalid`` from a script and sends everything else to the real
    server, so the platform half of each test is never faked."""

    def __init__(self, script: List[Dict[str, Any]]) -> None:
        self._script = script
        self._real = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "provider.invalid":
            reply = self._script.pop(0) if self._script else _reply({"role": "assistant", "content": "done"}, "stop")
            return httpx.Response(200, content=json.dumps(reply).encode(), headers={"content-type": "application/json"})
        return await self._real.handle_async_request(request)

    async def aclose(self) -> None:
        await self._real.aclose()


def _flatten(spans: List[TraceSpan]) -> List[TraceSpan]:
    out: List[TraceSpan] = []
    for s in spans:
        out.append(s)
        out.extend(_flatten(s.children))
    return out


async def _client(api_server: str, script: List[Dict[str, Any]] | None = None) -> AcruxCore:
    key = await signup_and_mint_key(api_server)
    return AcruxCore(key, api_server, max_retries=0, provider=PROVIDER, transport=FakeProvider(script or []))


async def test_a_step_tree_larger_than_one_batch_is_stored_whole(api_server: str) -> None:
    hub = await _client(api_server)
    async with hub:
        async with hub.traces.step("agent", kind="agent") as root:
            for n in range(250):
                with hub.traces.step(f"tool-{n}", kind="tool"):
                    pass
        await hub.traces.flush()
        stored = _flatten((await hub.traces.get(root.trace_id or "")).spans)
    assert len(stored) == 251


async def test_a_routed_capture_payloads_opt_out_is_honoured(api_server: str) -> None:
    hub = await _client(api_server)
    async with hub:
        async with hub.traces.step("handle", input={"ticket": "refund"}) as step:
            await hub.traces.ingest({
                "traceId": step.trace_id, "capturePayloads": False,
                "spans": [{"spanId": "pii-1", "parentSpanId": step.span_id, "name": "pii-lookup",
                           "kind": "tool", "status": "ok", "startTime": "2026-10-17T00:00:00Z",
                           "endTime": "2026-10-17T00:00:01Z", "input": {"ssn": "123-45-6789"}}],
            }, wait=False)
        await hub.traces.flush()
        stored = {s.name: s for s in _flatten((await hub.traces.get(step.trace_id or "")).spans)}
    assert "123-45-6789" not in json.dumps(stored["pii-lookup"].payload)
    # The opt-out covers the routed span only; the step keeps its own input.
    assert stored["handle"].payload and stored["handle"].payload.get("input") == {"ticket": "refund"}


async def test_two_byo_tool_loops_in_one_step_are_stored(api_server: str) -> None:
    call = {"role": "assistant", "content": None,
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}]}
    script = [_reply(call, "tool_calls"), _reply({"role": "assistant", "content": "a"}, "stop"),
              _reply(call, "tool_calls"), _reply({"role": "assistant", "content": "b"}, "stop")]
    hub = await _client(api_server, script)
    async with hub:
        async with hub.traces.step("handle") as step:
            for _ in range(2):
                await hub.gateway.run_tool_loop(
                    "stub-model", [{"role": "user", "content": "hi"}], tool_defs=[LOOKUP_DEF],
                    dispatch=lambda name, args: "ok", trace={"trace_id": step.trace_id},
                )
        await hub.traces.flush()
        stored = _flatten((await hub.traces.get(step.trace_id or "")).spans)
    assert [s.kind for s in stored].count("tool") == 2
    assert [s.kind for s in stored].count("llm") == 4


async def test_a_nested_step_that_ends_after_its_root_is_stored_with_its_call(api_server: str) -> None:
    import asyncio

    release = asyncio.Event()
    hub = await _client(api_server)
    async with hub:

        async def background() -> None:
            async with hub.traces.step("late-child"):
                await release.wait()
                await hub.gateway.chat("stub-model", [{"role": "user", "content": "hi"}])

        async with hub.traces.step("root", kind="agent") as root:
            task = asyncio.create_task(background())
            await asyncio.sleep(0)
        release.set()
        await task
        await hub.traces.flush()
        names = sorted(s.name for s in _flatten((await hub.traces.get(root.trace_id or "")).spans))
    assert names == ["late-child", "root", "stub-model"]


# The two below fail on the SDK before PR #613 with no step involved: the bugs shipped.


async def test_two_tool_loops_on_one_trace_keep_every_tool_span(api_server: str) -> None:
    call = {"role": "assistant", "content": None,
            "tool_calls": [{"id": "c", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}]}
    script = [_reply(call, "tool_calls"), _reply({"role": "assistant", "content": "a"}, "stop"),
              _reply(call, "tool_calls"), _reply({"role": "assistant", "content": "b"}, "stop")]
    hub = await _client(api_server, script)
    async with hub:
        first = await hub.gateway.run_tool_loop(
            "stub-model", [{"role": "user", "content": "x"}], tool_defs=[LOOKUP_DEF], dispatch=lambda n, a: "ok",
        )
        await hub.traces.flush()
        await hub.gateway.run_tool_loop(
            "stub-model", [{"role": "user", "content": "x"}], tool_defs=[LOOKUP_DEF], dispatch=lambda n, a: "ok",
            trace={"trace_id": first.trace_id},
        )
        await hub.traces.flush()
        kinds = [s.kind for s in _flatten((await hub.traces.get(first.trace_id or "")).spans)]
    assert kinds.count("tool") == 2 and kinds.count("llm") == 4


async def test_a_queued_capture_payloads_opt_out_is_not_merged_away(api_server: str) -> None:
    def span(span_id: str, name: str, value: Any) -> Dict[str, Any]:
        return {"spanId": span_id, "name": name, "kind": "chain", "status": "ok",
                "startTime": "2026-10-17T00:00:00Z", "input": value}

    hub = await _client(api_server)
    async with hub:
        opened = await hub.traces.ingest({"name": "t", "spans": [span("a", "open", {"x": 1})]})
        # Queued back to back, so the span queue sends them in one batch.
        await hub.traces.ingest({"traceId": opened.trace_id, "spans": [span("b", "public", {"x": 2})]}, wait=False)
        await hub.traces.ingest({"traceId": opened.trace_id, "capturePayloads": False,
                                 "spans": [span("c", "pii", {"ssn": "123-45-6789"})]}, wait=False)
        await hub.traces.flush()
        stored = {s.name: s for s in _flatten((await hub.traces.get(opened.trace_id)).spans)}
    assert "123-45-6789" not in json.dumps(stored["pii"].payload)
    assert stored["public"].payload and stored["public"].payload.get("input") == {"x": 2}
