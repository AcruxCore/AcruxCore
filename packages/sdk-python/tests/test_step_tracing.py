"""Tracing an app's own steps, and the ``chat()`` gaps that made it hard (issue #610).

Covers ``extra_body`` pass-through, ``trace={"parent_span_id": ...}``, the BYO trace
name, ``traces.step`` (decorator and context manager, sync and async),
``prompts.get_by_alias`` and the sync client ``AcruxCoreSync``.

Every test drives the real client through a mocked httpx transport — no network.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError

PROVIDER = {"base_url": "https://provider.invalid/v1", "api_key": "pk"}

PROMPT_ID = "11111111-1111-1111-1111-111111111111"
VERSION_ID = "22222222-2222-2222-2222-222222222222"


def completion(model: str = "stub-model") -> Dict[str, Any]:
    return {
        "id": "c1",
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
    }


def sse() -> bytes:
    frames = [
        {"id": "s1", "model": "stub-model", "choices": [{"index": 0, "delta": {"content": "pong"}, "finish_reason": "stop"}]},
        {"id": "s1", "model": "stub-model", "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}},
    ]
    return ("".join(f"data: {json.dumps(f)}\n\n" for f in frames) + "data: [DONE]\n\n").encode()


class Recorder:
    """Stands in for the platform API and a BYO provider, and records what each was sent."""

    def __init__(self) -> None:
        self.provider_bodies: List[Dict[str, Any]] = []
        self.gateway_calls: List[Dict[str, Any]] = []
        self.trace_posts: List[List[Dict[str, Any]]] = []
        self.get_paths: List[str] = []
        #: Provider replies to hand out in order before falling back to ``completion()``.
        self.provider_script: List[Dict[str, Any]] = []
        #: ``True`` makes this server answer ``GET /prompt-versions?name=&alias=``, the
        #: one-request lookup. Off, it answers that path as an older server does: a 404
        #: with no error code, because no route matched.
        self.alias_endpoint = False

    @property
    def traces(self) -> List[Dict[str, Any]]:
        return [t for post in self.trace_posts for t in post]

    @property
    def spans(self) -> List[Dict[str, Any]]:
        return [s for t in self.traces for s in t["spans"]]

    def handler(self) -> Callable[[httpx.Request], httpx.Response]:
        def handle(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            body = json.loads(request.content) if request.content else {}
            if request.url.host == "provider.invalid":
                self.provider_bodies.append(body)
                if body.get("stream"):
                    return httpx.Response(200, content=sse(), headers={"content-type": "text/event-stream"})
                if self.provider_script:
                    return httpx.Response(200, json=self.provider_script.pop(0))
                return httpx.Response(200, json=completion())
            if path.endswith("/traces"):
                self.trace_posts.append(body["traces"])
                return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})
            if path.endswith("/gateway/chat/completions"):
                self.gateway_calls.append({"body": body, "headers": dict(request.headers)})
                headers = {"x-gateway-trace-id": request.headers.get("x-trace-id", "gw-trace"), "x-gateway-span-id": "gw-span"}
                if body.get("stream"):
                    return httpx.Response(200, content=sse(), headers={"content-type": "text/event-stream", **headers})
                return httpx.Response(200, json=completion(), headers=headers)
            if request.method == "GET":
                self.get_paths.append(str(request.url.raw_path, "ascii"))
                if path.endswith("/prompt-versions") and self.alias_endpoint:
                    q = request.url.params
                    if (q.get("name"), q.get("alias")) != ("triage", "production"):
                        return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "Prompt or alias not found"}})
                    return httpx.Response(200, json={
                        "id": VERSION_ID, "promptId": PROMPT_ID, "versionNumber": 3,
                        "messages": [{"role": "system", "content": "Triage {{ ticket }}"}],
                        "variables": ["ticket"], "model": None, "createdBy": "u", "createdAt": "2026-10-01T00:00:00Z",
                    })
                if path.endswith("/prompts"):
                    return httpx.Response(200, json={"data": [
                        {"id": "other", "name": "triage-v2", "description": None, "createdAt": "2026-10-01T00:00:00Z"},
                        {"id": PROMPT_ID, "name": "triage", "description": None, "createdAt": "2026-10-01T00:00:00Z"},
                    ], "total": 2, "page": 1, "limit": 100})
                if path.endswith(f"/prompts/{PROMPT_ID}/aliases"):
                    return httpx.Response(200, json=[
                        {"id": "a1", "alias": "production", "versionId": VERSION_ID, "versionNumber": 3, "updatedAt": "2026-10-01T00:00:00Z"},
                        {"id": "a2", "alias": "staging", "versionId": "x", "versionNumber": 4, "updatedAt": "2026-10-01T00:00:00Z"},
                    ])
                if path.endswith(f"/prompts/{PROMPT_ID}/versions/4"):
                    return httpx.Response(200, json={
                        "id": "x", "promptId": PROMPT_ID, "versionNumber": 4,
                        "messages": [{"role": "system", "content": "Staging {{ ticket }}"}],
                        "variables": ["ticket"], "model": None, "createdBy": "u", "createdAt": "2026-10-01T00:00:00Z",
                    })
                if path.endswith(f"/prompts/{PROMPT_ID}/versions/3"):
                    return httpx.Response(200, json={
                        "id": VERSION_ID, "promptId": PROMPT_ID, "versionNumber": 3,
                        "messages": [{"role": "system", "content": "Triage {{ ticket }}"}],
                        "variables": ["ticket"], "model": None, "createdBy": "u", "createdAt": "2026-10-01T00:00:00Z",
                    })
            return httpx.Response(404, json={"error": {"message": f"unexpected {request.method} {path}"}})

        return handle


def make_client(rec: Recorder, **kwargs: Any) -> AcruxCore:
    return AcruxCore("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler()), **kwargs)


def by_name(spans: List[Dict[str, Any]], name: str) -> Dict[str, Any]:
    return next(s for s in spans if s["name"] == name)


# ── 1. extra_body ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_extra_body_reaches_the_gateway_and_a_byo_provider() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], extra_body={"top_p": 0.5, "seed": 7})
        await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], provider=PROVIDER, extra_body={"seed": 7})
        stream = await hub.gateway.stream("m", [{"role": "user", "content": "hi"}], provider=PROVIDER, extra_body={"seed": 9})
        async for _ in stream:
            pass

    assert rec.gateway_calls[0]["body"]["top_p"] == 0.5
    assert rec.gateway_calls[0]["body"]["seed"] == 7
    assert rec.provider_bodies[0]["seed"] == 7
    assert rec.provider_bodies[1]["seed"] == 9


@pytest.mark.asyncio
async def test_extra_body_may_not_overwrite_a_field_the_sdk_sets() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        with pytest.raises(AcruxCoreError) as err:
            await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], extra_body={"messages": []})
    assert err.value.code == "VALIDATION_ERROR"
    assert "messages" in str(err.value)
    assert rec.gateway_calls == []


# ── 2. parent span ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_parent_span_id_is_sent_on_the_gateway_route() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], trace={"trace_id": "t-1", "parent_span_id": "step-1"})
    assert rec.gateway_calls[0]["headers"]["x-parent-span-id"] == "step-1"
    assert rec.gateway_calls[0]["headers"]["x-trace-id"] == "t-1"


@pytest.mark.asyncio
async def test_parent_span_id_is_set_on_a_byo_span_from_chat_and_stream() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:
        await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], trace={"trace_id": "t-1", "parent_span_id": "step-1"})
        stream = await hub.gateway.stream("m", [{"role": "user", "content": "hi"}], trace={"trace_id": "t-1", "parent_span_id": "step-2"})
        async for _ in stream:
            pass
    assert [s["parentSpanId"] for s in rec.spans] == ["step-1", "step-2"]


# ── 4. BYO trace name ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_byo_span_uses_the_trace_name_from_chat_and_stream() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:
        await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], trace={"name": "triage"})
        stream = await hub.gateway.stream("m", [{"role": "user", "content": "hi"}], trace={"name": "reply"})
        async for _ in stream:
            pass
        await hub.gateway.chat("m", [{"role": "user", "content": "hi"}])
    assert [t["name"] for t in rec.traces] == ["triage", "reply", "chat"]


# ── 5. traces.step ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_async_steps_nest_and_a_gateway_call_lands_under_its_step() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:

        @hub.traces.step("classify", kind="chain")
        async def classify(ticket: str) -> str:
            result = await hub.gateway.chat("m", [{"role": "user", "content": ticket}])
            return result.content or ""

        @hub.traces.step("handle-ticket", kind="agent")
        async def handle(ticket: str) -> str:
            return await classify(ticket)

        assert await handle("printer on fire") == "pong"

    # One batch: the whole step tree arrives together, so every parent is known on ingest.
    assert len(rec.trace_posts) == 1 and len(rec.traces) == 1
    trace = rec.traces[0]
    assert trace["name"] == "handle-ticket"
    root, child = by_name(trace["spans"], "handle-ticket"), by_name(trace["spans"], "classify")
    assert "parentSpanId" not in root
    assert child["parentSpanId"] == root["spanId"]
    assert root["kind"] == "agent" and child["kind"] == "chain"
    assert root["input"] == {"ticket": "printer on fire"} and root["output"] == "pong"

    headers = rec.gateway_calls[0]["headers"]
    assert headers["x-trace-id"] == trace["traceId"]
    assert headers["x-parent-span-id"] == child["spanId"]
    assert headers["x-trace-name-if-unset"] == "handle-ticket"


@pytest.mark.asyncio
async def test_a_byo_call_inside_a_step_ships_with_the_step_tree() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:

        @hub.traces.step("answer")
        async def answer() -> None:
            await hub.gateway.chat("m", [{"role": "user", "content": "hi"}])
            stream = await hub.gateway.stream("m", [{"role": "user", "content": "hi"}])
            async for _ in stream:
                pass

        await answer()

    assert len(rec.traces) == 1
    step = by_name(rec.spans, "answer")
    llm = [s for s in rec.spans if s["kind"] == "llm"]
    assert len(llm) == 2
    assert all(s["parentSpanId"] == step["spanId"] for s in llm)


@pytest.mark.asyncio
async def test_a_failing_step_records_the_error_and_reraises() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:

        @hub.traces.step("lookup", kind="retrieval")
        async def lookup() -> None:
            raise KeyError("order-9")

        with pytest.raises(KeyError):
            await lookup()

    span = by_name(rec.spans, "lookup")
    assert span["status"] == "error"
    assert "order-9" in span["error"]


@pytest.mark.asyncio
async def test_context_manager_steps_and_unserialisable_values() -> None:
    rec = Recorder()

    class Ticket:
        def __repr__(self) -> str:
            return "Ticket(42)"

    async with make_client(rec) as hub:
        async with hub.traces.step("pipeline", input={"ticket": Ticket()}) as outer:
            with hub.traces.step("parse") as inner:
                inner.output = {"id": 42}
            outer.output = "done"

    pipeline, parse = by_name(rec.spans, "pipeline"), by_name(rec.spans, "parse")
    assert parse["parentSpanId"] == pipeline["spanId"] == outer.span_id
    assert pipeline["input"] == {"ticket": "Ticket(42)"}
    assert parse["output"] == {"id": 42}
    assert outer.trace_id == rec.traces[0]["traceId"]


@pytest.mark.asyncio
async def test_trace_false_inside_a_step_still_opts_out() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        async with hub.traces.step("quiet"):
            await hub.gateway.chat("m", [{"role": "user", "content": "hi"}], trace=False)
    assert "x-trace-id" not in rec.gateway_calls[0]["headers"]


# ── 6. sync client ─────────────────────────────────────────────────────────


def test_sync_client_traces_a_sync_app() -> None:
    from acruxcore import AcruxCoreSync

    rec = Recorder()
    with AcruxCoreSync("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler())) as hub:

        @hub.traces.step("draft", kind="chain")
        def draft(ticket: str) -> str:
            return hub.gateway.chat("m", [{"role": "user", "content": ticket}]).content or ""

        @hub.traces.step("handle-ticket", kind="agent")
        def handle(ticket: str) -> str:
            return draft(ticket)

        assert handle("refund please") == "pong"
        version = hub.prompts.get_by_alias("triage", "production")
        assert version.id == VERSION_ID
        chunks = [c.delta.get("content") or "" for c in hub.gateway.stream("m", [{"role": "user", "content": "x"}])]
        assert "".join(chunks) == "pong"

    # Closing the client flushed the buffered step tree.
    assert len(rec.traces) == 1
    child = by_name(rec.spans, "draft")
    assert rec.gateway_calls[0]["headers"]["x-parent-span-id"] == child["spanId"]
    assert rec.gateway_calls[0]["headers"]["x-trace-id"] == rec.traces[0]["traceId"]


def test_sync_client_keeps_each_thread_on_its_own_trace() -> None:
    from acruxcore import AcruxCoreSync

    rec = Recorder()
    with AcruxCoreSync("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler())) as hub:

        @hub.traces.step("job")
        def job(n: int) -> None:
            hub.gateway.chat("m", [{"role": "user", "content": str(n)}])

        threads = [threading.Thread(target=job, args=(n,)) for n in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    trace_ids = {t["traceId"] for t in rec.traces}
    assert len(trace_ids) == 4
    assert {c["headers"]["x-trace-id"] for c in rec.gateway_calls} == trace_ids


def test_sync_client_raises_instead_of_hanging_on_its_own_loop() -> None:
    from acruxcore import AcruxCoreSync

    rec = Recorder()
    with AcruxCoreSync("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler())) as hub:

        async def inside() -> None:
            # What a sync tool function run by the SDK's own loop would do.
            hub.prompts.get_by_alias("triage", "production")

        future = asyncio.run_coroutine_threadsafe(inside(), hub._loop)
        with pytest.raises(AcruxCoreError) as err:
            future.result(timeout=5)
    assert err.value.code == "VALIDATION_ERROR"


# ── 7. prompts.get_by_alias ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_by_alias_returns_the_template_without_rendering_and_caches_it() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        first = await hub.prompts.get_by_alias("triage", "production")
        second = await hub.prompts.get_by_alias("triage", "production")

    assert first.id == VERSION_ID and first.version_number == 3
    assert first.messages == [{"role": "system", "content": "Triage {{ ticket }}"}]
    assert second == first and second is not first  # a copy, so in-place rendering cannot leak
    # Exact name match: "triage-v2" also matches the search and must not be picked.
    assert len([p for p in rec.get_paths if "/versions/" in p]) == 1


@pytest.mark.asyncio
async def test_get_by_alias_names_what_is_missing() -> None:
    rec = Recorder()
    async with make_client(rec, cache_ttl=0) as hub:
        with pytest.raises(AcruxCoreError) as no_prompt:
            await hub.prompts.get_by_alias("nope", "production")
        with pytest.raises(AcruxCoreError) as no_alias:
            await hub.prompts.get_by_alias("triage", "canary")
    assert no_prompt.value.status_code == 404 and "nope" in str(no_prompt.value)
    assert no_alias.value.status_code == 404 and "canary" in str(no_alias.value)


# ── 8. review findings on PR #613 ──────────────────────────────────────────


def tool_call_completion(call_id: str = "call_1") -> Dict[str, Any]:
    return {
        "id": "c-tool",
        "model": "stub-model",
        "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
            "role": "assistant", "content": None,
            "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "lookup", "arguments": "{}"}}],
        }}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6},
    }


LOOKUP_DEF = {"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}}}


@pytest.mark.asyncio
async def test_a_step_tree_over_the_batch_cap_sends_every_parent_first() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        async with hub.traces.step("agent", kind="agent"):
            for n in range(250):
                with hub.traces.step(f"tool-{n}", kind="tool"):
                    pass

    # The server checks each parentSpanId against the request plus what is stored, so
    # every post must only point at spans it carries or that an earlier post carried.
    seen: set = set()
    for post in rec.trace_posts:
        batch = {s["spanId"] for t in post for s in t["spans"]}
        for t in post:
            for s in t["spans"]:
                assert s.get("parentSpanId") in (None, *seen, *batch), "child sent before its parent"
        seen |= batch
    assert len(rec.spans) == 251


@pytest.mark.asyncio
async def test_a_report_routed_into_a_step_keeps_its_trace_level_fields() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        async with hub.traces.step("handle") as step:
            await hub.traces.ingest({
                "traceId": step.trace_id, "capturePayloads": False, "tags": ["sensitive"],
                "metadata": {"tenant": "t-9"},
                "spans": [{"spanId": "secret-1", "parentSpanId": step.span_id, "name": "pii-lookup",
                           "kind": "tool", "status": "ok", "startTime": "2026-10-17T00:00:00Z",
                           "input": {"ssn": "123"}}],
            }, wait=False)

    secret_entries = [t for t in rec.traces if any(s["spanId"] == "secret-1" for s in t["spans"])]
    assert secret_entries and all(t.get("capturePayloads") is False for t in secret_entries)
    # The step's own span must not be swept into the opt-out.
    step_entry = next(t for t in rec.traces if any(s["name"] == "handle" for s in t["spans"]))
    assert step_entry.get("capturePayloads") is not False
    assert "sensitive" in step_entry["tags"] and step_entry["metadata"]["tenant"] == "t-9"


@pytest.mark.asyncio
async def test_a_span_reported_after_its_root_step_closed_is_still_sent() -> None:
    rec = Recorder()
    release = asyncio.Event()
    async with make_client(rec, provider=PROVIDER) as hub:

        async def background() -> None:
            await release.wait()
            await hub.gateway.chat("m", [{"role": "user", "content": "late"}])

        async with hub.traces.step("handle"):
            task = asyncio.create_task(background())
        await hub.traces.flush()  # the step tree is already on the wire
        release.set()
        await task
        await hub.traces.flush()
        assert hub._span_queue.pending_span_count == 0

    assert [s["kind"] for s in rec.spans].count("llm") == 1


@pytest.mark.asyncio
async def test_a_late_span_does_not_corrupt_the_queue_span_count() -> None:
    rec = Recorder()
    release = asyncio.Event()
    async with make_client(rec, provider=PROVIDER) as hub:

        async def background() -> None:
            await release.wait()
            await hub.gateway.chat("m", [{"role": "user", "content": "late"}])

        async with hub.traces.step("handle"):
            task = asyncio.create_task(background())
        release.set()  # no flush first: the root payload is still buffered
        await task
        await hub.traces.flush()
        assert hub._span_queue.pending_span_count == 0


@pytest.mark.asyncio
async def test_run_tool_loop_inside_a_step_offers_the_step_name() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        async with hub.traces.step("handle-ticket", kind="agent") as step:
            await hub.gateway.run_tool_loop("m", [{"role": "user", "content": "hi"}], trace={"trace_id": step.trace_id})
    assert rec.gateway_calls[0]["headers"]["x-trace-name-if-unset"] == "handle-ticket"


@pytest.mark.asyncio
async def test_two_byo_tool_loops_in_one_step_report_unique_span_ids() -> None:
    rec = Recorder()
    rec.provider_script = [tool_call_completion(), completion(), tool_call_completion(), completion()]
    async with make_client(rec, provider=PROVIDER) as hub:
        async with hub.traces.step("handle") as step:
            for _ in range(2):
                await hub.gateway.run_tool_loop(
                    "m", [{"role": "user", "content": "hi"}], tool_defs=[LOOKUP_DEF],
                    dispatch=lambda name, args: "ok", trace={"trace_id": step.trace_id},
                )

    for t in rec.traces:
        ids = [s["spanId"] for s in t["spans"]]
        assert len(ids) == len(set(ids)), f"duplicate spanIds: {sorted(ids)}"
    assert [s["kind"] for s in rec.spans].count("tool") == 2


def test_a_sync_client_dropped_without_close_stops_its_thread() -> None:
    import gc
    import time

    from acruxcore import AcruxCoreSync

    rec = Recorder()
    hub = AcruxCoreSync("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler()))
    thread = hub._thread
    hub.gateway.chat("m", [{"role": "user", "content": "hi"}])
    del hub
    gc.collect()
    deadline = time.time() + 5
    while thread.is_alive() and time.time() < deadline:
        time.sleep(0.05)
    assert not thread.is_alive(), "the client's loop thread outlived the client"


@pytest.mark.asyncio
async def test_the_step_decorator_wraps_an_async_generator() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:

        @hub.traces.step("retrieve", kind="retrieval")
        async def retrieve(q: str) -> Any:
            yield "doc-1"
            await hub.gateway.chat("m", [{"role": "user", "content": q}])
            yield "doc-2"

        assert [d async for d in retrieve("refund")] == ["doc-1", "doc-2"]

    span = by_name(rec.spans, "retrieve")
    assert "async_generator" not in json.dumps(span.get("output"))
    assert rec.gateway_calls[0]["headers"].get("x-parent-span-id") == span["spanId"]


@pytest.mark.asyncio
async def test_the_step_decorator_wraps_a_sync_generator() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:

        @hub.traces.step("parse")
        def parse(lines: List[str]) -> Any:
            for line in lines:
                with hub.traces.step("line"):
                    yield line.upper()

        assert list(parse(["a", "b"])) == ["A", "B"]

    span = by_name(rec.spans, "parse")
    lines = [s for s in rec.spans if s["name"] == "line"]
    assert len(lines) == 2 and all(s.get("parentSpanId") == span["spanId"] for s in lines)
    assert "generator" not in json.dumps(span.get("output"))


def test_breaking_out_of_a_sync_stream_releases_it() -> None:
    import gc

    from acruxcore import AcruxCoreSync

    rec = Recorder()
    with AcruxCoreSync("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler()), provider=PROVIDER) as hub:
        it = hub.gateway.stream("m", [{"role": "user", "content": "hi"}])
        gen = it._source._gen
        for _ in it:
            break
        del it
        gc.collect()
        hub.flush()
        assert gen.ag_frame is None, "the async generator is still suspended on the loop"


@pytest.mark.asyncio
async def test_get_by_alias_hands_out_a_copy_and_honours_max_cache_size() -> None:
    rec = Recorder()
    async with make_client(rec, max_cache_size=1) as hub:
        first = await hub.prompts.get_by_alias("triage", "production")
        first.messages[0]["content"] = "Triage printer on fire"
        cached = await hub.prompts.get_by_alias("triage", "production")
        assert cached.messages[0]["content"] == "Triage {{ ticket }}"
        # A cache hit must be a copy too, not only the first fetch.
        cached.messages[0]["content"] = "Triage a refund"
        again = await hub.prompts.get_by_alias("triage", "production")
        assert again.messages[0]["content"] == "Triage {{ ticket }}"

        await hub.prompts.get_by_alias("triage", "staging")  # evicts production
        await hub.prompts.get_by_alias("triage", "production")
    assert len([p for p in rec.get_paths if p.endswith("/versions/3")]) == 2


def test_a_step_whose_sink_fails_warns_instead_of_staying_silent() -> None:
    from acruxcore.steps import Step

    def broken(payload: Any) -> None:
        raise RuntimeError("Event loop is closed")

    with pytest.warns(UserWarning, match="Event loop is closed"):
        with Step("handle", kind="chain", sink=broken):
            pass


def assert_parents_sent_first(rec: Recorder) -> None:
    """Each post may only point at spans it carries or an earlier post carried — the
    server's parent check, which rejects a whole post otherwise."""
    seen: set = set()
    for post in rec.trace_posts:
        batch = {s["spanId"] for t in post for s in t["spans"]}
        for t in post:
            for s in t["spans"]:
                assert s.get("parentSpanId") in (None, *seen, *batch), f"{s['name']} sent before its parent"
        seen |= batch


@pytest.mark.asyncio
async def test_a_nested_step_that_ends_after_its_root_is_sent_with_what_it_holds() -> None:
    rec = Recorder()
    release = asyncio.Event()
    async with make_client(rec, provider=PROVIDER) as hub:

        async def background() -> None:
            async with hub.traces.step("late-child"):
                await release.wait()
                await hub.gateway.chat("m", [{"role": "user", "content": "hi"}])

        async with hub.traces.step("root", kind="agent"):
            task = asyncio.create_task(background())
            await asyncio.sleep(0)  # let the child open before the root ends
        release.set()
        await task

    assert_parents_sent_first(rec)
    root, child = by_name(rec.spans, "root"), by_name(rec.spans, "late-child")
    assert child["parentSpanId"] == root["spanId"]
    assert next(s for s in rec.spans if s["kind"] == "llm")["parentSpanId"] == child["spanId"]


@pytest.mark.asyncio
async def test_a_stream_read_after_its_step_ended_is_not_lost() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:
        async with hub.traces.step("answer"):
            stream = await hub.gateway.stream("m", [{"role": "user", "content": "hi"}])
        async for _ in stream:  # read after the step ended
            pass

    assert_parents_sent_first(rec)
    step = by_name(rec.spans, "answer")
    assert next(s for s in rec.spans if s["kind"] == "llm")["parentSpanId"] == step["spanId"]


@pytest.mark.asyncio
async def test_nested_steps_that_end_after_their_root_each_send_what_they_hold() -> None:
    rec = Recorder()
    gate_a, gate_b, chatted = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async with make_client(rec, provider=PROVIDER) as hub:

        async def late_a() -> None:
            async with hub.traces.step("late-a"):
                await hub.gateway.chat("m", [{"role": "user", "content": "hi"}])
                chatted.set()
                await gate_a.wait()

        async def late_b() -> None:
            async with hub.traces.step("late-b"):
                await gate_b.wait()

        async with hub.traces.step("root", kind="agent"):
            tasks = [asyncio.create_task(late_a()), asyncio.create_task(late_b())]
            await asyncio.sleep(0)
        # late-a's llm span is buffered while late-a is open; late-b ending first must not
        # send it ahead of late-a.
        await chatted.wait()
        gate_b.set()
        await asyncio.sleep(0.02)
        gate_a.set()
        await asyncio.gather(*tasks)

    assert_parents_sent_first(rec)
    root, a = by_name(rec.spans, "root"), by_name(rec.spans, "late-a")
    assert a["parentSpanId"] == root["spanId"]
    assert by_name(rec.spans, "late-b")["parentSpanId"] == root["spanId"]
    assert next(s for s in rec.spans if s["kind"] == "llm")["parentSpanId"] == a["spanId"]


# ── BYO trace gaps found during the #612 e2e run (issues #615, #616) ───────

TRACE_CTX = {"tags": ["vip", "refund"], "metadata": {"tenant": "acme"}}


@pytest.mark.asyncio
async def test_every_byo_report_keeps_trace_tags_and_metadata() -> None:
    rec = Recorder()
    rec.provider_script = [completion(), tool_call_completion(), completion()]
    hi = [{"role": "user", "content": "hi"}]
    async with make_client(rec, provider=PROVIDER) as hub:
        await hub.gateway.chat("m", hi, trace=dict(TRACE_CTX))
        async for _ in await hub.gateway.stream("m", hi, trace=dict(TRACE_CTX)):
            pass
        await hub.gateway.run_tool_loop(
            "m", hi, tool_defs=[LOOKUP_DEF], dispatch=lambda name, args: "ok", trace=dict(TRACE_CTX),
        )
        async for _ in await hub.gateway.run_tool_loop("m", hi, stream=True, trace=dict(TRACE_CTX)):
            pass
    # chat, stream, the blocking loop's two rounds and its tool span, the streamed loop's round.
    assert sorted(s["kind"] for s in rec.spans) == ["llm"] * 5 + ["tool"]
    for entry in rec.traces:
        assert entry.get("tags") == TRACE_CTX["tags"], entry
        assert entry.get("metadata") == TRACE_CTX["metadata"], entry


@pytest.mark.asyncio
async def test_a_byo_stream_left_early_is_reported_as_client_closed() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:
        stream = await hub.gateway.stream("m", [{"role": "user", "content": "hi"}], trace={"name": "preview"})
        async for _ in stream:
            break
        await stream.aclose()
    assert len(rec.spans) == 1
    span = rec.spans[0]
    assert (span["kind"], span["status"]) == ("llm", "ok")
    assert span["attributes"]["clientClosed"] is True
    assert span["output"]["content"] == "pong"
    assert rec.traces[0]["name"] == "preview"


@pytest.mark.asyncio
async def test_a_streamed_byo_tool_loop_left_early_reports_its_round() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:
        stream = await hub.gateway.run_tool_loop("m", [{"role": "user", "content": "hi"}], stream=True)
        async for _ in stream:
            break
        await stream.aclose()
    assert [s["kind"] for s in rec.spans] == ["llm"]
    assert rec.spans[0]["attributes"]["clientClosed"] is True


@pytest.mark.asyncio
async def test_a_byo_stream_left_early_with_trace_false_reports_nothing() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:
        stream = await hub.gateway.stream("m", [{"role": "user", "content": "hi"}], trace=False)
        async for _ in stream:
            break
        await stream.aclose()
    assert rec.spans == []


def test_a_sync_byo_stream_left_early_is_reported() -> None:
    from acruxcore import AcruxCoreSync

    rec = Recorder()
    with AcruxCoreSync("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler()), provider=PROVIDER) as hub:
        it = hub.gateway.stream("m", [{"role": "user", "content": "hi"}])
        for _ in it:
            break
        it.close()
        hub.flush()
    assert [s["attributes"].get("clientClosed") for s in rec.spans] == [True]


# ── 8. PR #613 review, second pass (2026-10-17) ────────────────────────────
#
# One test per finding. Each failed on the code before its fix.


def span_payload(name: str, parent: Optional[str] = None, kind: str = "tool") -> Dict[str, Any]:
    import uuid as _uuid

    span: Dict[str, Any] = {
        "spanId": str(_uuid.uuid4()), "name": name, "kind": kind, "status": "ok",
        "startTime": "2026-10-17T00:00:00Z", "endTime": "2026-10-17T00:00:01Z",
    }
    if parent:
        span["parentSpanId"] = parent
    return span


@pytest.mark.asyncio
async def test_a_call_on_another_client_inside_a_step_stays_on_its_own_client() -> None:
    rec_a, rec_b = Recorder(), Recorder()
    async with make_client(rec_a) as hub_a, make_client(rec_b) as hub_b:
        async with hub_a.traces.step("handle") as step:
            await hub_b.gateway.chat("m", [{"role": "user", "content": "hi"}], provider=PROVIDER)
            await hub_b.gateway.chat("m", [{"role": "user", "content": "hi"}])
            a_trace = step.trace_id

    # B's BYO span went to B, with B's key, not into A's trace.
    assert [s["kind"] for s in rec_a.spans] == ["chain"]
    assert [s["kind"] for s in rec_b.spans] == ["llm"]
    assert rec_b.traces[0]["traceId"] != a_trace
    # B's gateway call did not borrow A's trace id or parent.
    assert rec_b.gateway_calls[0]["headers"].get("x-trace-id") != a_trace
    assert "x-parent-span-id" not in rec_b.gateway_calls[0]["headers"]


@pytest.mark.asyncio
async def test_a_sync_function_returning_a_coroutine_is_traced_as_async() -> None:
    rec = Recorder()
    async with make_client(rec, provider=PROVIDER) as hub:

        async def fetch_inner(q: str) -> str:
            await asyncio.sleep(0.02)
            await hub.gateway.chat("m", [{"role": "user", "content": q}])
            return "done"

        def fetch(q: str) -> Any:  # what a plain third-party decorator leaves behind
            return fetch_inner(q)

        traced = hub.traces.step("fetch")(fetch)
        assert await traced("refund") == "done"

    span = by_name(rec.spans, "fetch")
    assert span["output"] == "done"
    llm = next(s for s in rec.spans if s["kind"] == "llm")
    assert llm["parentSpanId"] == span["spanId"]


@pytest.mark.asyncio
async def test_a_decorated_generator_forwards_send_and_throw() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:

        @hub.traces.step("echo")
        def echo() -> Any:
            got = yield "ready"
            while True:
                try:
                    got = yield f"got {got}"
                except ValueError:
                    got = yield "recovered"

        @hub.traces.step("aecho")
        async def aecho() -> Any:
            got = yield "ready"
            while True:
                try:
                    got = yield f"got {got}"
                except ValueError:
                    got = yield "recovered"

        gen = echo()
        assert next(gen) == "ready"
        assert gen.send("a") == "got a"
        assert gen.throw(ValueError("x")) == "recovered"
        assert gen.send("b") == "got b"
        gen.close()

        agen = aecho()
        assert await agen.__anext__() == "ready"
        assert await agen.asend("a") == "got a"
        assert await agen.athrow(ValueError("x")) == "recovered"
        assert await agen.asend("b") == "got b"
        await agen.aclose()

    assert by_name(rec.spans, "echo")["status"] == "ok"
    assert by_name(rec.spans, "aecho")["status"] == "ok"


@pytest.mark.asyncio
async def test_a_huge_root_step_is_capped_and_not_dropped_by_the_queue() -> None:
    from acruxcore import steps

    rec = Recorder()
    async with make_client(rec) as hub:
        async with hub.traces.step("batch") as step:
            for n in range(2500):
                await hub.traces.ingest(
                    {"traceId": step.trace_id, "spans": [span_payload(f"item-{n}", step.span_id)]}, wait=False
                )
            # Memory is bounded while the step runs.
            assert len(steps._roots[step.trace_id].spans) <= 1000
        # Anything queued behind the root report must not push it out of the queue.
        await hub.traces.ingest({"name": "other", "spans": [span_payload("other")]}, wait=False)

    batch = by_name(rec.spans, "batch")
    assert batch["attributes"]["droppedSpans"] == 1500
    assert len([s for s in rec.spans if s["name"].startswith("item-")]) == 1000


@pytest.mark.asyncio
async def test_extra_body_may_not_overwrite_stream_options_on_a_byo_stream() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        with pytest.raises(AcruxCoreError) as err:
            stream = await hub.gateway.stream(
                "m", [{"role": "user", "content": "hi"}], provider=PROVIDER,
                extra_body={"stream_options": {"include_usage": False}},
            )
            async for _ in stream:
                pass
    assert err.value.code == "VALIDATION_ERROR"
    assert "stream_options" in str(err.value)
    assert rec.provider_bodies == []


def test_a_report_landing_while_a_sync_root_step_flushes_is_not_lost() -> None:
    from acruxcore import AcruxCoreSync, steps

    rec = Recorder()
    with AcruxCoreSync("acx_sk_test", "https://api.invalid/api/v1", transport=httpx.MockTransport(rec.handler())) as hub:
        with hub.traces.step("root") as step:
            trace_id, span_id = step.trace_id, step.span_id
            root = steps._roots[trace_id]

            class Racing(type(root)):  # type: ignore[misc, valid-type]
                """Lets another thread report at the moment the flush swaps in the spans
                it holds back — the window where an unlocked report was lost."""

                fired = False

                def __setattr__(self, key: str, value: Any) -> None:
                    if key == "spans" and not Racing.fired:
                        Racing.fired = True
                        late = threading.Thread(target=lambda: hub.traces.ingest(
                            {"traceId": trace_id, "spans": [span_payload("late", span_id)]}, wait=False
                        ))
                        late.start()
                        late.join(0.3)
                    super().__setattr__(key, value)

            root.__class__ = Racing
        hub.flush()

    assert "late" in [s["name"] for s in rec.spans]


@pytest.mark.asyncio
async def test_one_step_object_can_be_reused_and_shared_by_concurrent_tasks() -> None:
    rec = Recorder()
    async with make_client(rec) as hub:
        poll = hub.traces.step("poll")
        for n in range(2):
            with poll:
                if n == 0:
                    poll.output = "first"

        handle = hub.traces.step("handle")

        async def run(n: int) -> None:
            async with handle as step:
                await asyncio.sleep(0.02 * (2 - n))
                step.output = n
                await hub.gateway.chat("m", [{"role": "user", "content": str(n)}])

        await asyncio.gather(run(0), run(1))

    polls = [s for s in rec.spans if s["name"] == "poll"]
    assert [p.get("output") for p in polls] == ["first", None]
    handles = [s for s in rec.spans if s["name"] == "handle"]
    assert sorted(h["output"] for h in handles) == [0, 1]
    assert all(h["status"] == "ok" for h in handles)
    # Each gateway call joined the step of its own task.
    by_trace = {t["traceId"]: t["spans"][0] for t in rec.traces}
    for call in rec.gateway_calls:
        parent = by_trace[call["headers"]["x-trace-id"]]
        assert call["headers"]["x-parent-span-id"] == parent["spanId"]
        assert str(parent["output"]) == call["body"]["messages"][0]["content"]


@pytest.mark.asyncio
async def test_flushing_a_large_step_tree_is_not_quadratic(monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    from acruxcore import steps

    # Above the per-root cap, so the cost of the flush itself is what is measured.
    monkeypatch.setattr(steps, "MAX_STEP_SPANS", 100_000, raising=False)
    rec = Recorder()
    async with make_client(rec) as hub:
        hub._span_queue._max_queued_spans = 100_000
        step = hub.traces.step("batch")
        with step:
            for n in range(2000):
                await hub.traces.ingest(
                    {"traceId": step.trace_id, "spans": [span_payload(f"a-{n}", step.span_id)]}, wait=False
                )
            # A nested step still open when the root ends keeps its subtree buffered,
            # so the root's flush must check every span against it.
            inner = hub.traces.step("inner")
            inner.__enter__()
            for n in range(2000):
                await hub.traces.ingest(
                    {"traceId": step.trace_id, "spans": [span_payload(f"b-{n}", inner.span_id)]}, wait=False
                )
            started = time.perf_counter()
        root_flush = time.perf_counter() - started
        started = time.perf_counter()
        inner.__exit__(None, None, None)
        inner_flush = time.perf_counter() - started

    assert len(rec.spans) == 4002
    assert root_flush < 0.25, f"root flush took {root_flush:.2f}s"
    assert inner_flush < 0.25, f"late flush took {inner_flush:.2f}s"


@pytest.mark.asyncio
async def test_get_by_alias_is_one_request_on_a_server_that_resolves_it() -> None:
    rec = Recorder()
    rec.alias_endpoint = True
    async with make_client(rec, cache_ttl=0) as hub:
        version = await hub.prompts.get_by_alias("triage", "production")
        assert version.id == VERSION_ID and version.version_number == 3
        assert rec.get_paths == ["/api/v1/prompt-versions?name=triage&alias=production"]

        rec.get_paths.clear()
        with pytest.raises(AcruxCoreError) as err:
            await hub.prompts.get_by_alias("triage", "canary")
    assert err.value.status_code == 404
    # A real "not found" from the server is final: no fallback scan.
    assert len(rec.get_paths) == 1
