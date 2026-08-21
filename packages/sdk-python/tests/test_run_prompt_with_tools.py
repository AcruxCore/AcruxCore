"""``gateway.run_prompt_with_tools`` and the streaming tool loop.

Every test drives the real client through a mocked httpx transport — no network, no
API key needed — and asserts on the bodies that would have gone out and the events
that come back. Streaming rounds are served as real SSE frames so the SDK's own
frame parsing and tool-call fragment accumulation are under test, not stubbed.
"""

from __future__ import annotations

import json
import warnings
from typing import Any, Callable, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError, RenderResult, ToolResolution

pytestmark = pytest.mark.asyncio


def make_client(handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any) -> AcruxCore:
    """A client wired to a mock transport, pointed at a loopback base_url."""
    return AcruxCore(
        api_key="k",
        base_url="http://localhost:3001/api/v1",
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


def body_of(request: httpx.Request) -> Dict[str, Any]:
    return json.loads(request.content.decode("utf-8"))


def sse(*frames: Dict[str, Any]) -> bytes:
    """Serialise chat-completion chunks as an SSE body, terminated with [DONE]."""
    out = "".join(f"data: {json.dumps(f)}\n\n" for f in frames)
    return (out + "data: [DONE]\n\n").encode("utf-8")


def chunk(
    *, content: str | None = None, tool_calls: List[Dict[str, Any]] | None = None,
    finish_reason: str | None = None,
) -> Dict[str, Any]:
    delta: Dict[str, Any] = {}
    if content is not None:
        delta["content"] = content
    if tool_calls is not None:
        delta["tool_calls"] = tool_calls
    return {
        "id": "chatcmpl-1",
        "model": "gpt-4o-mini",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def render_result(
    *, model: str | None = "gpt-4o-mini", resolutions: List[ToolResolution] | None = None
) -> RenderResult:
    """A RenderResult shaped exactly as `prompts.render` builds one."""
    return RenderResult(
        messages=[{"role": "user", "content": "Weather in Lisbon?"}],
        tools=[
            {
                "type": "function",
                "function": {"name": "get_weather", "parameters": {"type": "object"}},
            }
        ]
        if resolutions
        else [],
        tool_resolutions=resolutions or [],
        model=model,
        version_id="ver-123",
        version_number=4,
    )


#: A non-streaming completion with no tool calls — the loop's exit condition.
PLAIN_COMPLETION = {
    "id": "chatcmpl-1",
    "model": "gpt-4o-mini",
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "Sunny."}, "finish_reason": "stop"}
    ],
    "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
}


def resolved(name: str, *, executor: str = "client", version: int = 4) -> Dict[str, Any]:
    return {
        "toolId": "tool-1",
        "versionNumber": version,
        "executorType": executor,
        "function": {"name": name, "parameters": {"type": "object"}},
    }


# ── run_prompt_with_tools: what it derives ────────────────────────────────────


async def test_derives_model_messages_refs_and_prompt_version_id():
    seen: Dict[str, Dict[str, Any]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            seen["resolve"] = body_of(request)
            return httpx.Response(200, json={"data": [resolved("get_weather")]})
        seen["chat"] = body_of(request)
        return httpx.Response(200, json=PLAIN_COMPLETION, headers={"x-gateway-trace-id": "tr-1"})

    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(name="get_weather", alias="production", version_number=4, source="alias")
            ]
        )
        result = await hub.gateway.run_prompt_with_tools(r, tools=None, dispatch=lambda n, a: "x")

    assert result.content == "Sunny."
    assert seen["resolve"]["refs"] == [{"name": "get_weather", "alias": "production"}]
    assert seen["chat"]["model"] == "gpt-4o-mini"
    assert seen["chat"]["messages"] == [{"role": "user", "content": "Weather in Lisbon?"}]
    assert seen["chat"]["tool_refs"] == [{"name": "get_weather", "alias": "production"}]


async def test_the_gateway_is_told_the_prompt_version_so_its_own_spans_carry_lineage():
    """The gateway writes the llm span on this path, so lineage must travel in the body."""
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["chat"] = body_of(request)
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        await hub.gateway.run_prompt_with_tools(render_result())

    assert seen["chat"]["prompt_version_id"] == "ver-123"


async def test_prompt_version_id_is_never_sent_to_a_byo_provider():
    bodies: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/traces"):
            return httpx.Response(200, json={"traceId": "tr-1"})
        bodies.append(body_of(request))
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        await hub.gateway.run_prompt_with_tools(
            render_result(), provider={"base_url": "https://localhost/v1", "api_key": "pk"}
        )

    assert bodies and all("prompt_version_id" not in b for b in bodies)


async def test_prompt_version_id_reaches_the_trace_without_being_restated():
    """The one field that is easy to forget by hand — it must ride along on its own."""
    traces: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/traces"):
            traces.append(body_of(request))
            return httpx.Response(200, json={"traceId": "tr-1"})
        return httpx.Response(200, json=PLAIN_COMPLETION, headers={"x-gateway-trace-id": "tr-1"})

    async with make_client(handler) as hub:
        # A BYO provider makes the SDK write the llm span itself, so the span this test
        # needs to inspect is in a request body rather than only on the server.
        r = render_result()
        await hub.gateway.run_prompt_with_tools(
            r, provider={"base_url": "https://localhost/v1", "api_key": "pk"}
        )
        await hub.gateway.flush()

    spans = [s for t in traces for tr in t["traces"] for s in tr["spans"]]
    assert [s["promptVersionId"] for s in spans] == ["ver-123"]


async def test_a_pinned_binding_travels_as_a_pin_not_as_an_alias():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            seen["resolve"] = body_of(request)
            return httpx.Response(200, json={"data": [resolved("get_weather", version=2)]})
        seen["chat"] = body_of(request)
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(
                    name="get_weather", alias=None, pinned_version_number=2,
                    version_number=2, source="alias",
                )
            ]
        )
        await hub.gateway.run_prompt_with_tools(r, dispatch=lambda n, a: "x")

    assert seen["resolve"]["refs"] == [{"name": "get_weather", "version": 2}]
    assert seen["chat"]["tool_refs"] == [{"name": "get_weather", "version": 2}]


async def test_no_bound_model_and_no_override_names_both_fixes():
    async with make_client(lambda r: httpx.Response(200, json=PLAIN_COMPLETION)) as hub:
        with pytest.raises(AcruxCoreError) as excinfo:
            await hub.gateway.run_prompt_with_tools(render_result(model=None))

    message = str(excinfo.value)
    assert "bind a default model" in message
    assert "model=" in message


async def test_an_explicit_model_wins_over_the_bound_one():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["chat"] = body_of(request)
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        await hub.gateway.run_prompt_with_tools(render_result(model=None), model="gpt-4o")

    assert seen["chat"]["model"] == "gpt-4o"


async def test_a_prompt_with_no_tools_is_a_plain_completion():
    calls: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        result = await hub.gateway.run_prompt_with_tools(render_result())

    assert result.content == "Sunny."
    assert not any(p.endswith("/tools/resolve") for p in calls)


async def test_a_client_tool_with_nothing_to_run_it_still_raises_missing_dispatch():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("get_weather")]})
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(name="get_weather", alias="production", version_number=4, source="alias")
            ]
        )
        with pytest.raises(AcruxCoreError) as excinfo:
            await hub.gateway.run_prompt_with_tools(r)

    assert excinfo.value.code == "MISSING_DISPATCH"


# ── streaming ─────────────────────────────────────────────────────────────────


async def test_streaming_emits_content_tool_call_tool_result_then_done():
    """One tool round, then a streamed answer — the whole event contract in one test."""
    rounds: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("get_weather")]})
        if request.url.path.endswith("/traces"):
            return httpx.Response(200, json={"traceId": "tr-1"})
        rounds.append(body_of(request))
        headers = {"x-gateway-trace-id": "tr-1", "x-gateway-span-id": f"span-{len(rounds)}"}
        if len(rounds) == 1:
            return httpx.Response(
                200,
                content=sse(
                    chunk(content="Let me check."),
                    chunk(tool_calls=[{"index": 0, "id": "call-1", "function": {"name": "get_weather"}}]),
                    chunk(tool_calls=[{"index": 0, "function": {"arguments": '{"city":'}}]),
                    chunk(tool_calls=[{"index": 0, "function": {"arguments": '"Lisbon"}'}}]),
                    chunk(finish_reason="tool_calls"),
                ),
                headers=headers,
            )
        return httpx.Response(
            200,
            content=sse(chunk(content="Sunny "), chunk(content="in Lisbon."), chunk(finish_reason="stop")),
            headers=headers,
        )

    events: List[Any] = []
    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(name="get_weather", alias="production", version_number=4, source="alias")
            ]
        )
        stream = await hub.gateway.run_prompt_with_tools(
            r, stream=True, dispatch=lambda name, args: {"tempC": 21, "city": args["city"]}
        )
        async for event in stream:
            events.append(event)

    assert [e.type for e in events] == [
        "content", "tool_call", "tool_result", "content", "content", "done",
    ]
    assert events[0].delta == "Let me check."
    assert events[1].name == "get_weather"
    assert events[1].arguments == {"city": "Lisbon"}  # reassembled from four fragments
    assert events[1].round == 0
    assert events[2].result == {"tempC": 21, "city": "Lisbon"}
    assert events[2].error is None
    assert events[3].round == 1
    assert events[-1].result.content == "Sunny in Lisbon."
    assert events[-1].result.iterations == 2
    assert events[-1].result.trace_id == "tr-1"
    # Both rounds streamed, and the tool result was fed back into the second one.
    assert all(body.get("stream") is True for body in rounds)
    assert rounds[1]["messages"][-1] == {
        "role": "tool", "tool_call_id": "call-1", "content": '{"tempC": 21, "city": "Lisbon"}',
    }


async def test_streaming_keeps_every_round_on_one_trace_and_parents_the_tool_span():
    """Streaming must not cost observability: same trace, tool span under the round's llm span."""
    sent_headers: List[httpx.Headers] = []
    traces: List[Dict[str, Any]] = []
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("get_weather")]})
        if request.url.path.endswith("/traces"):
            traces.append(body_of(request))
            return httpx.Response(200, json={"traceId": "tr-1"})
        calls["n"] += 1
        sent_headers.append(request.headers)
        headers = {"x-gateway-trace-id": "tr-1", "x-gateway-span-id": f"span-{calls['n']}"}
        if calls["n"] == 1:
            return httpx.Response(
                200,
                content=sse(
                    chunk(tool_calls=[{"index": 0, "id": "c1", "function": {"name": "get_weather", "arguments": "{}"}}]),
                    chunk(finish_reason="tool_calls"),
                ),
                headers=headers,
            )
        return httpx.Response(200, content=sse(chunk(content="ok"), chunk(finish_reason="stop")), headers=headers)

    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(name="get_weather", alias="production", version_number=4, source="alias")
            ]
        )
        stream = await hub.gateway.run_prompt_with_tools(r, stream=True, dispatch=lambda n, a: "21C")
        async for _ in stream:
            pass
        await hub.gateway.flush()

    # Round 1 has no trace to join yet; round 2 joins the one the gateway minted.
    assert "x-trace-id" not in sent_headers[0]
    assert sent_headers[1]["x-trace-id"] == "tr-1"
    assert sent_headers[0]["x-trace-name"] == "runToolLoop"

    tool_spans = [
        s for t in traces for tr in t["traces"] for s in tr["spans"] if s["kind"] == "tool"
    ]
    assert len(tool_spans) == 1
    assert tool_spans[0]["name"] == "get_weather"
    assert tool_spans[0]["parentSpanId"] == "span-1"
    assert tool_spans[0]["output"] == "21C"
    assert all(tr["traceId"] == "tr-1" for t in traces for tr in t["traces"])


async def test_a_failing_tool_reports_the_error_event_then_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("get_weather")]})
        if request.url.path.endswith("/traces"):
            return httpx.Response(200, json={"traceId": "tr-1"})
        return httpx.Response(
            200,
            content=sse(
                chunk(tool_calls=[{"index": 0, "id": "c1", "function": {"name": "get_weather", "arguments": "{}"}}]),
                chunk(finish_reason="tool_calls"),
            ),
            headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "span-1"},
        )

    def boom(name: str, args: Dict[str, Any]) -> Any:
        raise RuntimeError("upstream is down")

    events: List[Any] = []
    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(name="get_weather", alias="production", version_number=4, source="alias")
            ]
        )
        stream = await hub.gateway.run_prompt_with_tools(r, stream=True, dispatch=boom)
        with pytest.raises(RuntimeError, match="upstream is down"):
            async for event in stream:
                events.append(event)

    assert events[-1].type == "tool_result"
    assert events[-1].error == "upstream is down"
    assert events[-1].result is None


async def test_streaming_stops_at_max_iterations_without_hanging():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("get_weather")]})
        if request.url.path.endswith("/traces"):
            return httpx.Response(200, json={"traceId": "tr-1"})
        return httpx.Response(
            200,
            content=sse(
                chunk(tool_calls=[{"index": 0, "id": "c1", "function": {"name": "get_weather", "arguments": "{}"}}]),
                chunk(finish_reason="tool_calls"),
            ),
            headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "s1"},
        )

    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(name="get_weather", alias="production", version_number=4, source="alias")
            ]
        )
        stream = await hub.gateway.run_prompt_with_tools(
            r, stream=True, max_iterations=2, dispatch=lambda n, a: "21C"
        )
        events = [e async for e in stream]

    done = events[-1]
    assert done.type == "done"
    assert done.result.stopped_at_limit is True
    assert done.result.iterations == 2
    assert [e.type for e in events].count("tool_call") == 2


async def test_run_tool_loop_streams_directly_too():
    """`stream=True` is on the loop itself, not only on the render-result shortcut."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=sse(chunk(content="hi"), chunk(finish_reason="stop")),
            headers={"x-gateway-trace-id": "tr-9", "x-gateway-span-id": "s1"},
        )

    async with make_client(handler) as hub:
        stream = await hub.gateway.run_tool_loop(
            "gpt-4o-mini", [{"role": "user", "content": "hi"}], stream=True
        )
        events = [e async for e in stream]

    assert [e.type for e in events] == ["content", "done"]
    assert events[-1].result.content == "hi"


# ── client_tools ──────────────────────────────────────────────────────────────
#
# The point of `client_tools` is that the catalog keeps the definition while the caller
# supplies only the implementation. So these tests assert on what does NOT happen as
# much as on what does: no /tools/sync request, the binding's own ref, the catalog's
# version stamp on the span.


def asks_for(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """A buffered completion whose assistant message calls one tool."""
    return {
        "id": "chatcmpl-1",
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "index": 0,
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
    }


def client_resolution(name: str = "search_flights") -> ToolResolution:
    return ToolResolution(name=name, alias="production", version_number=4, source="alias")


async def test_client_tools_runs_the_mapped_function_without_touching_the_catalog():
    """The whole feature in one test: the function runs, and nothing is synced."""
    paths: List[str] = []
    ran: List[Dict[str, Any]] = []
    rounds = {"n": 0}

    async def search_flights(origin: str, destination: str) -> Dict[str, Any]:
        ran.append({"origin": origin, "destination": destination})
        return {"cheapest_usd": 240}

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("search_flights")]})
        rounds["n"] += 1
        if rounds["n"] == 1:
            return httpx.Response(
                200,
                json=asks_for("search_flights", {"origin": "LHE", "destination": "IST"}),
                headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-1"},
            )
        return httpx.Response(200, json=PLAIN_COMPLETION, headers={"x-gateway-trace-id": "tr-1"})

    async with make_client(handler) as hub:
        result = await hub.gateway.run_prompt_with_tools(
            render_result(resolutions=[client_resolution()]),
            client_tools={"search_flights": search_flights},
        )

    assert result.content == "Sunny."
    # Called with the schema's own parameter names, not one args dict.
    assert ran == [{"origin": "LHE", "destination": "IST"}]
    # The definition stayed in the catalog: resolved, never synced.
    assert any(p.endswith("/tools/resolve") for p in paths)
    assert not any(p.endswith("/tools/sync") for p in paths)


async def test_client_tools_keeps_the_bindings_alias_and_the_version_stamp():
    """`tools=[fn], sync=False` loses both of these — that is why the flag exists."""
    seen: Dict[str, Any] = {}
    traces: List[Dict[str, Any]] = []
    rounds = {"n": 0}

    def search_flights(origin: str) -> str:
        return "PK-709"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("search_flights", version=7)]})
        if request.url.path.endswith("/traces"):
            traces.append(body_of(request))
            return httpx.Response(200, json={"accepted": 1, "traceIds": ["tr-1"]})
        rounds["n"] += 1
        if rounds["n"] == 1:
            seen["chat"] = body_of(request)
            return httpx.Response(
                200,
                json=asks_for("search_flights", {"origin": "LHE"}),
                headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-1"},
            )
        return httpx.Response(200, json=PLAIN_COMPLETION, headers={"x-gateway-trace-id": "tr-1"})

    async with make_client(handler) as hub:
        await hub.gateway.run_prompt_with_tools(
            render_result(resolutions=[client_resolution()]),
            client_tools={"search_flights": search_flights},
        )
        await hub.gateway.flush()

    assert seen["chat"]["tool_refs"] == [{"name": "search_flights", "alias": "production"}]
    spans = [s for t in traces for tr in t["traces"] for s in tr["spans"]]
    tool_spans = [s for s in spans if s["kind"] == "tool"]
    assert [s["attributes"]["toolVersionId"] for s in tool_spans] == ["tool-1:7"]


async def test_a_pin_still_travels_as_a_pin_when_client_tools_runs_the_tool():
    seen: Dict[str, Any] = {}
    rounds = {"n": 0}

    def search_flights(origin: str) -> str:
        return "PK-709"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            seen["resolve"] = body_of(request)
            return httpx.Response(200, json={"data": [resolved("search_flights", version=2)]})
        rounds["n"] += 1
        if rounds["n"] == 1:
            seen["chat"] = body_of(request)
            return httpx.Response(
                200,
                json=asks_for("search_flights", {"origin": "LHE"}),
                headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-1"},
            )
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        r = render_result(
            resolutions=[
                ToolResolution(
                    name="search_flights", alias=None, pinned_version_number=2,
                    version_number=2, source="alias",
                )
            ]
        )
        await hub.gateway.run_prompt_with_tools(
            r, client_tools={"search_flights": search_flights}
        )

    assert seen["resolve"]["refs"] == [{"name": "search_flights", "version": 2}]
    assert seen["chat"]["tool_refs"] == [{"name": "search_flights", "version": 2}]


async def test_a_typod_key_is_named_in_the_missing_dispatch_message():
    """The keys that WERE supplied are what make a typo a one-second fix."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("search_flights")]})
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        with pytest.raises(AcruxCoreError) as excinfo:
            await hub.gateway.run_prompt_with_tools(
                render_result(resolutions=[client_resolution()]),
                client_tools={"search_flight": lambda origin: "x"},
            )

    assert excinfo.value.code == "MISSING_DISPATCH"
    assert "search_flights" in str(excinfo.value)
    assert "['search_flight']" in str(excinfo.value)


async def test_an_http_tool_in_client_tools_is_ignored_silently():
    """One map serves both aliases of a tool: production http, staging client.

    So an entry for a tool that resolves to `http` must be ignored without a word — our
    own guide script passes exactly this map for both aliases, and a warning here fired
    twice on every correct run.
    """
    executed: List[str] = []
    rounds = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(
                200, json={"data": [resolved("get_city_weather", executor="http")]}
            )
        if "/execute" in request.url.path:
            executed.append(request.url.path)
            return httpx.Response(
                200,
                json={
                    "result": {"tempC": 31},
                    "status": 200,
                    "latencyMs": 12,
                    "toolVersionId": "tool-1:4",
                },
            )
        rounds["n"] += 1
        if rounds["n"] == 1:
            return httpx.Response(
                200,
                json=asks_for("get_city_weather", {"city": "Lahore"}),
                headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-1"},
            )
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        r = render_result(resolutions=[client_resolution("get_city_weather")])
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            result = await hub.gateway.run_prompt_with_tools(
                r, client_tools={"get_city_weather": lambda city: "unused"}
            )

    assert result.content == "Sunny."
    # The platform ran it, not the supplied function.
    assert len(executed) == 1


async def test_a_function_that_cannot_take_the_arguments_fails_before_any_model_call():
    """The old `def search_flights(args: dict)` shape, caught at wiring time."""
    paths: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "toolId": "tool-1",
                            "versionNumber": 4,
                            "executorType": "client",
                            "function": {
                                "name": "search_flights",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "origin": {"type": "string"},
                                        "destination": {"type": "string"},
                                    },
                                    "required": ["origin", "destination"],
                                },
                            },
                        }
                    ]
                },
            )
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        with pytest.raises(AcruxCoreError) as excinfo:
            await hub.gateway.run_prompt_with_tools(
                render_result(resolutions=[client_resolution()]),
                client_tools={"search_flights": lambda args: args},
            )

    assert excinfo.value.code == "VALIDATION_ERROR"
    assert "['origin', 'destination']" in str(excinfo.value)
    # Nothing was spent: the loop never reached the gateway.
    assert not any(p.endswith("/gateway/chat/completions") for p in paths)


async def test_kwargs_and_no_required_fields_both_skip_the_arity_check():
    """The check must not block a function it cannot read confidently."""
    rounds = {"n": 0}
    calls: List[Dict[str, Any]] = []

    def search_flights(**kwargs: Any) -> str:
        calls.append(kwargs)
        return "PK-709"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "toolId": "tool-1",
                            "versionNumber": 4,
                            "executorType": "client",
                            "function": {
                                "name": "search_flights",
                                "parameters": {
                                    "type": "object",
                                    "properties": {"origin": {"type": "string"}},
                                    "required": ["origin"],
                                },
                            },
                        }
                    ]
                },
            )
        rounds["n"] += 1
        if rounds["n"] == 1:
            return httpx.Response(
                200,
                json=asks_for("search_flights", {"origin": "LHE"}),
                headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-1"},
            )
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        result = await hub.gateway.run_prompt_with_tools(
            render_result(resolutions=[client_resolution()]),
            client_tools={"search_flights": search_flights},
        )

    assert result.content == "Sunny."
    assert calls == [{"origin": "LHE"}]


async def test_client_tools_works_on_the_streaming_path_too():
    ran: List[str] = []
    rounds = {"n": 0}

    async def search_flights(origin: str) -> str:
        ran.append(origin)
        return "PK-709"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("search_flights")]})
        rounds["n"] += 1
        if rounds["n"] == 1:
            return httpx.Response(
                200,
                content=sse(
                    chunk(
                        tool_calls=[
                            {
                                "index": 0,
                                "id": "call-1",
                                "function": {"name": "search_flights", "arguments": '{"origin":"LHE"}'},
                            }
                        ]
                    ),
                    chunk(finish_reason="tool_calls"),
                ),
                headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-1"},
            )
        return httpx.Response(
            200,
            content=sse(chunk(content="Cheapest is PK-709."), chunk(finish_reason="stop")),
            headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-2"},
        )

    async with make_client(handler) as hub:
        stream = await hub.gateway.run_prompt_with_tools(
            render_result(resolutions=[client_resolution()]),
            stream=True,
            client_tools={"search_flights": search_flights},
        )
        events = [e async for e in stream]

    assert ran == ["LHE"]
    assert [e.type for e in events] == ["tool_call", "tool_result", "content", "done"]
    assert events[-1].result.content == "Cheapest is PK-709."


async def test_a_decorated_tool_of_the_same_name_wins_over_client_tools():
    """Precedence: tools= owns the definition, so it must also own the execution."""
    from acruxcore import acrux

    which: List[str] = []
    rounds = {"n": 0}

    @acrux.tool
    def search_flights(origin: str) -> str:
        """Search flights."""
        which.append("decorated")
        return "PK-709"

    def from_map(origin: str) -> str:
        which.append("mapped")
        return "PK-999"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/sync"):
            return httpx.Response(
                200, json={"toolId": "tool-1", "versionNumber": 1, "committed": True, "alias": "production"}
            )
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [resolved("search_flights")]})
        rounds["n"] += 1
        if rounds["n"] == 1:
            return httpx.Response(
                200,
                json=asks_for("search_flights", {"origin": "LHE"}),
                headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "llm-1"},
            )
        return httpx.Response(200, json=PLAIN_COMPLETION)

    async with make_client(handler) as hub:
        await hub.gateway.run_prompt_with_tools(
            render_result(resolutions=[client_resolution()]),
            tools=[search_flights],
            client_tools={"search_flights": from_map},
        )

    assert which == ["decorated"]
