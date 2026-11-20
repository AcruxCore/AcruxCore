"""``traces.step`` and ``acruxcore.otel.register()`` write one trace (issue #797).

With ``register()`` called, an open step is also the active OpenTelemetry span, so a span
that OTel instrumentation starts inside a step (an ``openai`` call under
``register(instrument=["openai"])``) is the step's child, in the step's trace. Mirrors the
TypeScript fix for issue #789 (sdk-faq Q66).

The step side goes through the real client over a mocked httpx transport; the OTel side
goes through the provider ``register()`` built, with an in-memory exporter added to it.
"""

from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from typing import Any, Dict, Iterator, List

import httpx
import pytest
from opentelemetry import trace as otel_trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.util._once import Once

from acruxcore import AcruxCore
from acruxcore import steps as steps_module
from acruxcore.otel import register


class Recorder:
    """Stands in for the platform API and records every trace report it was sent."""

    def __init__(self) -> None:
        self.spans: List[Dict[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        if request.url.path.endswith("/traces"):
            for t in body["traces"]:
                for s in t["spans"]:
                    self.spans.append({**s, "traceId": t["traceId"]})
            return httpx.Response(200, json={"accepted": 1, "traceIds": ["t"]})
        return httpx.Response(404, json={"error": {"message": "unexpected"}})


def make_client(rec: Recorder) -> AcruxCore:
    return AcruxCore("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handle))


def by_name(spans: List[Dict[str, Any]], name: str) -> Dict[str, Any]:
    return next(s for s in spans if s["name"] == name)


def otel_ids(span: Any) -> Dict[str, Any]:
    """An OTel span's trace id, as a UUID string, and its parent's span id, as hex."""
    hex_trace = format(span.context.trace_id, "032x")
    uuid = f"{hex_trace[:8]}-{hex_trace[8:12]}-{hex_trace[12:16]}-{hex_trace[16:20]}-{hex_trace[20:]}"
    parent = format(span.parent.span_id, "016x") if span.parent else None
    return {"trace_id": uuid, "parent_span_id": parent}


def _reset_otel() -> None:
    # OTel's set_tracer_provider() takes effect once per process; reset its guard.
    otel_trace._TRACER_PROVIDER = None
    otel_trace._TRACER_PROVIDER_SET_ONCE = Once()
    # register() installed the step bridge; take it out so the next test starts clean.
    clear = getattr(steps_module, "set_step_context_bridge", None)
    if clear is not None:
        clear(None)


@pytest.fixture(scope="module")
def otlp_sink() -> Iterator[str]:
    """A local endpoint that accepts and discards OTLP exports, so ``register()``'s own
    exporter has somewhere to send without retrying. Yields its base URL."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 (stdlib name)
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/api/v1"
    server.shutdown()
    server.server_close()


@pytest.fixture
def exporter(otlp_sink: str) -> Iterator[InMemorySpanExporter]:
    """``register()`` with the default ``set_global=True``, plus an in-memory exporter."""
    _reset_otel()
    provider = register(api_key="k", base_url=otlp_sink)
    memory = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    yield memory
    # Export what register()'s batch processor holds while the sink is still up.
    provider.shutdown()
    _reset_otel()


def otel_span_in_step() -> None:
    otel_trace.get_tracer("test").start_span("llm-call").end()


@pytest.mark.asyncio
async def test_an_otel_span_inside_an_async_step_is_its_child(exporter: InMemorySpanExporter) -> None:
    rec = Recorder()
    async with make_client(rec) as hub:

        @hub.traces.step("agent", kind="agent")
        async def agent() -> str:
            await asyncio.sleep(0)
            otel_span_in_step()
            return "ok"

        await agent()

    step = by_name(rec.spans, "agent")
    [llm] = exporter.get_finished_spans()
    assert otel_ids(llm) == {"trace_id": step["traceId"], "parent_span_id": step["spanId"]}


@pytest.mark.asyncio
async def test_nested_steps_parent_otel_spans_to_the_innermost_step(exporter: InMemorySpanExporter) -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        async with hub.traces.step("agent", kind="agent"):
            otel_span_in_step()
            with hub.traces.step("tool", kind="tool"):
                otel_span_in_step()
            otel_span_in_step()

    agent, tool = by_name(rec.spans, "agent"), by_name(rec.spans, "tool")
    assert tool["parentSpanId"] == agent["spanId"]
    parents = [otel_ids(s) for s in exporter.get_finished_spans()]
    assert parents == [
        {"trace_id": agent["traceId"], "parent_span_id": agent["spanId"]},
        {"trace_id": agent["traceId"], "parent_span_id": tool["spanId"]},
        {"trace_id": agent["traceId"], "parent_span_id": agent["spanId"]},
    ]


@pytest.mark.asyncio
async def test_a_sync_decorated_step_and_generators_are_bridged(exporter: InMemorySpanExporter) -> None:
    rec = Recorder()
    async with make_client(rec) as hub:

        @hub.traces.step("plain")
        def plain() -> None:
            otel_span_in_step()

        @hub.traces.step("gen")
        def gen() -> Iterator[int]:
            otel_span_in_step()
            yield 1

        @hub.traces.step("agen")
        async def agen() -> Any:
            otel_span_in_step()
            yield 1

        plain()
        assert list(gen()) == [1]
        assert [x async for x in agen()] == [1]
        # Between a generator's items the consumer runs outside the step.
        otel_span_in_step()

    finished = exporter.get_finished_spans()
    for span, name in zip(finished[:3], ["plain", "gen", "agen"]):
        step = by_name(rec.spans, name)
        assert otel_ids(span) == {"trace_id": step["traceId"], "parent_span_id": step["spanId"]}
    assert finished[3].parent is None


@pytest.mark.asyncio
async def test_without_register_steps_never_touch_otel() -> None:
    _reset_otel()
    provider = TracerProvider()
    memory = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    rec = Recorder()
    async with make_client(rec) as hub:
        async with hub.traces.step("agent"):
            provider.get_tracer("t").start_span("llm-call").end()

    [span] = memory.get_finished_spans()
    assert span.parent is None
    # Without the bridge, a step's span id stays a UUID.
    assert len(by_name(rec.spans, "agent")["spanId"]) == 36


@pytest.mark.asyncio
async def test_the_bridge_stands_aside_inside_a_recording_otel_span(exporter: InMemorySpanExporter) -> None:
    rec = Recorder()
    tracer = otel_trace.get_tracer("framework")
    async with make_client(rec) as hub:
        with tracer.start_as_current_span("framework-tool") as outer:
            async with hub.traces.step("wrapped-tool", kind="tool"):
                otel_span_in_step()

    inner = next(s for s in exporter.get_finished_spans() if s.name == "llm-call")
    assert inner.parent is not None and inner.parent.span_id == outer.get_span_context().span_id


@pytest.mark.asyncio
async def test_the_bridge_stands_aside_when_register_is_not_global(otlp_sink: str) -> None:
    _reset_otel()
    try:
        provider = register(api_key="k", base_url=otlp_sink, set_global=False)
        memory = InMemorySpanExporter()
        provider.add_span_processor(SimpleSpanProcessor(memory))
        rec = Recorder()
        async with make_client(rec) as hub:
            async with hub.traces.step("agent"):
                provider.get_tracer("t").start_span("llm-call").end()
        [span] = memory.get_finished_spans()
        assert span.parent is None
        provider.shutdown()
    finally:
        _reset_otel()
