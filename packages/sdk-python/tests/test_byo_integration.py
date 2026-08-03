"""Gateway-vs-BYO comparison suite — Python mirror of the Node SDK's
``packages/sdk/test/integration/byo.integration.test.ts`` (design doc §4).

Node boots the real `apps/api` Express app IN-PROCESS via Jest, because both are
JavaScript. Python cannot do that across the language boundary, so this suite
instead boots a real `apps/api` server as a subprocess (see `conftest.py`'s
`api_server` fixture) and drives it entirely over real HTTP with `httpx` — the
same transport the SDK itself uses. `conftest.py`'s `provisioned_env` fixture
self-provisions a fresh team (signup, API key, a `greeting` prompt promoted to
`production`, and a real gateway connection + model bound to
`ACRUXCORE_TEST_MODEL` via OpenRouter), exactly like the Node suite's
`beforeAll` — so every comparison below makes two REAL, live calls: one through
our gateway (routed to the same OpenRouter connection via the registered
model), one directly to OpenRouter (BYO). The comparison isolates the gateway
hop itself, per design §4.

All tests share ONE `hub` fixture (see `conftest.py`) for the same reason the
Node suite gives for its single shared `hub`: every comparison should hit the
same team/user/model, and the SDK's default `max_retries=1` needs to survive
for the 429-retry test.

CONCURRENCY WARNING: do not run this file at the same time as `npm test` (or
any other integration suite) against the same `TEST_DATABASE_URL` — see
`conftest.py`'s module docstring for why.
"""

from __future__ import annotations

import http.server
import json
import os
import threading
import time
import uuid
import warnings
from typing import Any, Dict, List

import pytest

from conftest import _load_root_env

# Loaded here (this file's own module scope), not in `conftest.py` — collecting
# THIS file is exactly the signal that these values are actually needed; the
# other 3 test files in this directory never import this module, so they never
# trigger this call. See `conftest.py`'s docstring for the full reasoning.
_load_root_env()

PROVIDER_BASE_URL = os.environ.get("ACRUXCORE_TEST_PROVIDER_BASE_URL", "")
PROVIDER_API_KEY = os.environ.get("ACRUXCORE_TEST_PROVIDER_API_KEY", "")
TEST_MODEL = os.environ.get("ACRUXCORE_TEST_MODEL") or "gpt-4o-mini"

# Every test below is async and shares one event loop for the whole module, so
# the session-scoped `hub` fixture's underlying httpx.AsyncClient is only ever
# used from the loop it was created in.
pytestmark = pytest.mark.asyncio(loop_scope="session")

_BYO_PROVIDER: Dict[str, str] = {"base_url": PROVIDER_BASE_URL, "api_key": PROVIDER_API_KEY}


# --- gateway vs BYO — latency (design §4.1) --------------------------------


async def test_latency_p50_both_paths(hub):
    """Loops `chat()` 5x through the gateway, then 5x BYO, and reports p50 for each.

    Not a strict "BYO is faster" assertion (network variance, single sample) —
    this test's job is to PRODUCE the number for a human to read, per design
    §4.1, matching the Node suite's own reasoning verbatim.
    """
    n = 5
    messages: List[Dict[str, Any]] = [{"role": "user", "content": 'Say the word "test".'}]

    gateway_times_ms: List[float] = []
    for _ in range(n):
        start = time.monotonic()
        await hub.chat(TEST_MODEL, messages, trace=False)
        gateway_times_ms.append((time.monotonic() - start) * 1000)

    byo_times_ms: List[float] = []
    for _ in range(n):
        start = time.monotonic()
        await hub.chat(TEST_MODEL, messages, provider=_BYO_PROVIDER, trace=False)
        byo_times_ms.append((time.monotonic() - start) * 1000)

    def p50(values: List[float]) -> float:
        ordered = sorted(values)
        return ordered[len(ordered) // 2]

    print(
        f"[latency] gateway p50={p50(gateway_times_ms):.0f}ms "
        f"byo p50={p50(byo_times_ms):.0f}ms"
    )
    assert len(gateway_times_ms) == n
    assert len(byo_times_ms) == n


# --- gateway vs BYO — tool-calling (design §4.2) ---------------------------

_WEATHER_TOOL_DEF: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}


async def _dispatch_weather(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if name == "get_weather":
        return {"city": args.get("city"), "tempC": 18}
    raise ValueError(f"unknown tool {name}")


@pytest.mark.parametrize(
    "label,provider_config",
    [
        ("gateway", None),
        ("BYO", _BYO_PROVIDER),
    ],
)
async def test_tool_calling_dispatches_and_answers(hub, label, provider_config):
    """Both arms independently run the tool loop and must dispatch the tool
    and produce a final answer — mirrors the Node suite's `it.each` over
    (gateway, BYO)."""
    kwargs: Dict[str, Any] = {"provider": provider_config} if provider_config else {}
    result = await hub.run_tool_loop(
        TEST_MODEL,
        [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
        tool_defs=[_WEATHER_TOOL_DEF],
        dispatch=_dispatch_weather,
        **kwargs,
    )
    assert result.stopped_at_limit is False
    assert len(result.content) > 0
    assert any(m.get("role") == "tool" for m in result.messages)


# --- gateway vs BYO — result correctness (design §4.3) ---------------------


async def test_temperature_zero_matches_between_paths(hub):
    """finish_reason and token counts must match (within tolerance) between paths."""
    messages: List[Dict[str, Any]] = [
        {"role": "user", "content": "Reply with exactly the word: pineapple"}
    ]

    gateway_result = await hub.chat(TEST_MODEL, messages, temperature=0, trace=False)
    byo_result = await hub.chat(
        TEST_MODEL, messages, temperature=0, trace=False, provider=_BYO_PROVIDER
    )

    assert byo_result.finish_reason == gateway_result.finish_reason

    gateway_tokens = gateway_result.usage.total_tokens if gateway_result.usage else 0
    byo_tokens = byo_result.usage.total_tokens if byo_result.usage else 0
    # Allow a small tolerance — different request paths may tokenize a trailing
    # newline differently; the design calls for "consistent," not byte-identical.
    assert abs((byo_tokens or 0) - (gateway_tokens or 0)) <= 2


# --- BYO trace read-back ----------------------------------------------------


async def test_byo_trace_readback_one_llm_span(hub):
    """`get_trace` shows one trace with one `llm` span: `costUsd` null, `promptVersionId` stamped."""
    rendered = await hub.render_prompt("greeting", "production", {"name": "Alice"})
    result = await hub.chat(
        TEST_MODEL,
        rendered.messages,
        prompt_version_id=rendered.version_id,
        provider=_BYO_PROVIDER,
    )

    trace = await hub.get_trace(result.gateway.trace_id)
    assert len(trace.spans) == 1
    assert trace.spans[0].kind == "llm"
    assert trace.spans[0].cost_usd is None
    if rendered.version_id:
        assert trace.spans[0].prompt_version_id == rendered.version_id


async def test_byo_chained_trace_two_sibling_spans(hub):
    """Two chained BYO `chat()` calls sharing one `trace_id` land as sibling spans."""
    first = await hub.chat(TEST_MODEL, [{"role": "user", "content": "a"}], provider=_BYO_PROVIDER)
    await hub.chat(
        TEST_MODEL,
        [{"role": "user", "content": "b"}],
        provider=_BYO_PROVIDER,
        trace={"trace_id": first.gateway.trace_id},
    )

    trace = await hub.get_trace(first.gateway.trace_id)
    assert len(trace.spans) == 2
    assert all(span.parent_span_id is None for span in trace.spans)


# --- gateway-path trace opt-in (final-review I1) ----------------------------


async def test_gateway_trace_opt_in_writes_a_second_span_without_colliding(hub):
    """`chat(trace=True)` on the GATEWAY path must actually write its span.

    The span the gateway persists for a completion already occupies
    `(traceId, spanRef)` — `spans` is unique on that pair with no upsert — so
    re-using `result.gateway.span_ref` as the client-reported span id made the
    ingest endpoint 500, and `chat()`'s best-effort catch swallowed it: the
    documented opt-in recorded nothing, on every call. Only a test that goes
    through the REAL ingest endpoint (real Postgres, real unique constraint) can
    see that, which is why this case exists.

    Two assertions, both needed: no best-effort warning was emitted (so the POST
    really succeeded rather than being swallowed), and the trace holds both spans
    — the gateway's own and the newly reported one, under distinct ids.
    """
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = await hub.chat(
            TEST_MODEL, [{"role": "user", "content": 'Say the word "test".'}], trace=True
        )

    reports = [str(w.message) for w in caught if "trace report failed" in str(w.message)]
    assert reports == []

    trace = await hub.get_trace(result.gateway.trace_id)
    assert len(trace.spans) == 2
    assert all(span.kind == "llm" for span in trace.spans)
    span_ids = {span.span_id for span in trace.spans}
    # The gateway's own span is still there under its own id, and the client's
    # second span sits beside it under a freshly minted one.
    assert result.gateway.span_ref in span_ids
    assert any(span_id.startswith("chat-") for span_id in span_ids)


# --- BYO run_tool_loop span timing + ordering (final-review I2 / I5) ---------


def _flatten(spans: List[Any]) -> List[Any]:
    """Depth-first flatten of a `get_trace` span tree (which nests via `children`)."""
    out: List[Any] = []
    for span in spans:
        out.append(span)
        out.extend(_flatten(span.children))
    return out


async def test_byo_tool_loop_llm_spans_record_real_latency(hub):
    """Every BYO round's `llm` span must report the round's real duration.

    `startTime` used to be stamped alongside `endTime`, after the completion had
    already returned, so the ingest endpoint (which derives `latencyMs` from
    exactly that difference) stored 0 ms for every BYO tool-loop round — the one
    number BYO exists to improve, reported as zero.
    """
    result = await hub.run_tool_loop(
        TEST_MODEL,
        [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
        tool_defs=[_WEATHER_TOOL_DEF],
        dispatch=_dispatch_weather,
        provider=_BYO_PROVIDER,
    )

    trace = await hub.get_trace(result.trace_id)
    llm_spans = [span for span in _flatten(trace.spans) if span.kind == "llm"]
    assert len(llm_spans) >= 1
    assert all((span.latency_ms or 0) > 0 for span in llm_spans)


async def test_byo_tool_loop_http_tool_span_nests_under_the_round_llm_span(hub, provisioned_env):
    """A BYO loop calling a `tool_refs` tool with a SERVER-SIDE (`http`) executor.

    Two things used to go wrong here, both invisible to every other route. The SDK
    held all its spans until loop end, so when the platform ran the tool mid-loop
    it found no trace under the client-minted id, created one itself named
    `tool:<toolName>`, and dropped the supplied parent — leaving the tool span
    orphaned at the trace root of a mis-named trace. Reporting each round's `llm`
    span as soon as the round returns fixes both.

    This is also the only live coverage of the resolver-fed inlining branch
    (`tool_refs` → resolved schema inlined for a BYO provider, which has no
    catalog to resolve refs against).
    """
    result = await hub.run_tool_loop(
        TEST_MODEL,
        [
            {
                "role": "user",
                "content": (
                    "Call the probe_endpoint tool, then tell me the status number it "
                    "returned."
                ),
            }
        ],
        tool_refs=[{"name": provisioned_env["http_tool_name"], "alias": "production"}],
        provider=_BYO_PROVIDER,
    )

    trace = await hub.get_trace(result.trace_id)
    # The SDK named the trace, not the tool-execute endpoint.
    assert trace.trace.name == "runToolLoop"

    all_spans = _flatten(trace.spans)
    llm_span_ids = {span.span_id for span in all_spans if span.kind == "llm"}
    tool_spans = [span for span in all_spans if span.kind == "tool"]
    assert len(tool_spans) >= 1
    # Written by the platform (not the SDK), and nested under the round's llm span.
    assert all(span.attributes.get("executorType") == "http" for span in tool_spans)
    assert all(span.parent_span_id in llm_span_ids for span in tool_spans)
    # Nothing orphaned at the root: every root of this trace is an `llm` span.
    assert all(span.kind == "llm" for span in trace.spans)


# --- live BYO streaming (design §4 additional coverage) ---------------------


async def test_byo_streaming_chat_accumulates_and_traces_one_llm_span(hub):
    """A REAL SSE stream from a live provider — the first in this suite.

    Mocked unit tests cannot validate real framing (keep-alive comment frames,
    `\\r\\n` line endings, where the usage frame lands relative to `[DONE]`), and
    §4 asks for streaming BYO coverage explicitly. `trace_id` is supplied by the
    caller because a streamed call has no `ChatResult` to hand one back on — that
    is the documented way to read a streamed trace back.
    """
    trace_id = str(uuid.uuid4())
    stream = await hub.chat(
        TEST_MODEL,
        [{"role": "user", "content": "Count from 1 to 5, separated by single spaces."}],
        stream=True,
        provider=_BYO_PROVIDER,
        trace={"trace_id": trace_id},
    )

    content = ""
    finish_reason = None
    chunks = 0
    async for chunk in stream:
        chunks += 1
        content += chunk.delta.get("content") or ""
        if chunk.finish_reason:
            finish_reason = chunk.finish_reason

    assert chunks > 1  # a real stream, not one all-at-once frame
    assert len(content.strip()) > 0
    assert finish_reason == "stop"

    trace = await hub.get_trace(trace_id)
    assert len(trace.spans) == 1
    span = trace.spans[0]
    assert span.kind == "llm"
    assert span.provider == "openrouter.ai"
    assert (span.latency_ms or 0) > 0
    # `stream_options: {"include_usage": True}` really did come back on the wire.
    assert (span.total_tokens or 0) > 0
    assert (span.prompt_tokens or 0) > 0
    assert (span.completion_tokens or 0) > 0


# --- BYO 429 retry (design §4 additional coverage, no live credential needed) --


class _FlakyOnceHandler(http.server.BaseHTTPRequestHandler):
    """Returns 429 on the first request, then a valid OpenAI-shaped 200.

    `request_count` is set per-subclass (see the test below) so each test gets
    its own independent counter rather than sharing class state across runs.
    """

    request_count = 0

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming convention
        type(self).request_count += 1
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)  # drain the request body

        if type(self).request_count == 1:
            body = json.dumps({"error": "rate limited"}).encode("utf-8")
            self.send_response(429)
        else:
            body = json.dumps(
                {
                    "id": "c1",
                    "model": "m",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                }
            ).encode("utf-8")
            self.send_response(200)

        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        pass  # silence BaseHTTPRequestHandler's default per-request stderr logging


async def test_byo_429_retries_once_and_succeeds(hub):
    """A local mock server (no live credentials needed) returns 429 then 200 —
    the SDK must retry once and return the successful result."""
    handler_cls = type("_FlakyOnceHandlerInstance", (_FlakyOnceHandler,), {"request_count": 0})
    server = http.server.HTTPServer(("127.0.0.1", 0), handler_cls)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        result = await hub.chat(
            "m",
            [{"role": "user", "content": "hi"}],
            provider={"base_url": f"http://localhost:{port}", "api_key": "k"},
            trace=False,
        )
        assert handler_cls.request_count == 2
        assert result.content == "ok"
    finally:
        server.shutdown()
        thread.join(timeout=5)
