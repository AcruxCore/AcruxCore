"""Unit tests for the background span queue and the client wiring around it.

No network and no event-loop tricks for the queue itself — the sender is a plain
coroutine the test controls. The client-level regression test uses an
``httpx.MockTransport`` so the traces route can be made deliberately slow, which makes
"did the call wait for it?" a deterministic assertion rather than a statistical one.

Mirrors ``packages/sdk/test/unit/span-queue.test.ts`` and
``packages/sdk/test/unit/background-trace.test.ts``.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

from acruxcore.span_queue import SpanQueue


def entry(trace_id: str | None, count: int = 1) -> Dict[str, Any]:
    """One trace entry carrying ``count`` spans."""
    payload: Dict[str, Any] = {
        "name": "test",
        "spans": [
            {
                "spanId": f"{trace_id or 'anon'}-s{i}",
                "name": "span",
                "kind": "llm",
                "status": "ok",
                "startTime": "2026-07-30T00:00:00.000Z",
                "endTime": "2026-07-30T00:00:00.000Z",
            }
            for i in range(count)
        ],
    }
    if trace_id:
        payload["traceId"] = trace_id
    return payload


def trace_ids_of(batches: List[List[Dict[str, Any]]]) -> List[str]:
    """Trace ids of every entry in every batch, flattened."""
    return [e.get("traceId", "anon") for b in batches for e in b]


def spans_in(batch: List[Dict[str, Any]]) -> int:
    """Spans in one batch, across its entries."""
    return sum(len(e["spans"]) for e in batch)


def warning_count(recwarn, needle: str) -> int:
    """How many recorded warnings mention ``needle``."""
    return sum(needle in str(w.message) for w in recwarn)


async def test_enqueue_does_not_block():
    async def slow(_batch):
        await asyncio.sleep(0.2)

    q = SpanQueue(slow)
    loop = asyncio.get_running_loop()
    before = loop.time()
    q.enqueue(entry("t1"))
    assert loop.time() - before < 0.01
    await q.close()


async def test_lone_span_sends_on_the_next_turn_of_the_loop():
    sent: List[List[Dict[str, Any]]] = []

    async def send(batch):
        sent.append(batch)

    q = SpanQueue(send)
    q.enqueue(entry("t1"))
    # One turn of the loop is all it takes — there is no timer to wait for.
    await asyncio.sleep(0)
    assert trace_ids_of(sent) == ["t1"]
    await q.flush()


async def test_coalesces_what_arrives_during_a_send():
    sent: List[List[str]] = []
    gate = asyncio.Event()
    calls = 0

    async def send(batch):
        nonlocal calls
        calls += 1
        sent.append([e.get("traceId", "anon") for e in batch])
        if calls == 1:
            await gate.wait()

    q = SpanQueue(send)
    q.enqueue(entry("t1"))
    await asyncio.sleep(0)  # let the drain task pick up the first entry
    q.enqueue(entry("t2"))
    q.enqueue(entry("t3"))
    gate.set()
    await q.flush()

    assert sent[0] == ["t1"]
    assert sent[1] == ["t2", "t3"]


async def test_never_two_sends_at_once():
    in_flight = 0
    peak = 0

    async def send(_batch):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.005)
        in_flight -= 1

    q = SpanQueue(send)
    for i in range(10):
        q.enqueue(entry(f"t{i}"))
    await q.flush()
    assert peak == 1


async def test_merges_entries_sharing_a_trace_id():
    sent: List[List[Dict[str, Any]]] = []
    gate = asyncio.Event()
    calls = 0

    async def send(batch):
        nonlocal calls
        calls += 1
        sent.append(batch)
        if calls == 1:
            await gate.wait()

    q = SpanQueue(send)
    q.enqueue(entry("same"))  # goes out alone, opening the request
    await asyncio.sleep(0)
    q.enqueue(entry("same"))
    q.enqueue(entry("same", 2))
    q.enqueue(entry("other"))
    gate.set()
    await q.flush()

    assert len(sent[1]) == 2
    assert sent[1][0]["traceId"] == "same"
    assert len(sent[1][0]["spans"]) == 3
    assert sent[1][1]["traceId"] == "other"


async def test_does_not_merge_entries_without_a_trace_id():
    sent: List[List[Dict[str, Any]]] = []
    gate = asyncio.Event()
    calls = 0

    async def send(batch):
        nonlocal calls
        calls += 1
        sent.append(batch)
        if calls == 1:
            await gate.wait()

    q = SpanQueue(send)
    q.enqueue(entry("opener"))
    await asyncio.sleep(0)
    q.enqueue(entry(None))
    q.enqueue(entry(None))
    gate.set()
    await q.flush()

    assert len(sent[1]) == 2
    assert all("traceId" not in e for e in sent[1])


async def test_splits_at_the_span_cap():
    sent: List[List[Dict[str, Any]]] = []

    async def send(batch):
        sent.append(batch)

    q = SpanQueue(send, max_batch_spans=200)
    q.enqueue(entry("t1", 150))
    q.enqueue(entry("t2", 150))
    await q.flush()

    assert max(spans_in(b) for b in sent) <= 200
    assert sum(spans_in(b) for b in sent) == 300
    assert trace_ids_of(sent) == ["t1", "t2"]


async def test_splits_a_single_over_cap_entry_that_has_a_trace_id():
    sent: List[List[Dict[str, Any]]] = []

    async def send(batch):
        sent.append(batch)

    q = SpanQueue(send, max_batch_spans=100)
    q.enqueue(entry("big", 250))
    await q.flush()

    assert [spans_in(b) for b in sent] == [100, 100, 50]
    order = [s["spanId"] for b in sent for e in b for s in e["spans"]]
    assert order[0] == "big-s0"
    assert order[249] == "big-s249"
    assert all(e["traceId"] == "big" for b in sent for e in b)


async def test_sends_an_over_cap_entry_without_a_trace_id_whole():
    sent: List[List[Dict[str, Any]]] = []

    async def send(batch):
        sent.append(batch)

    q = SpanQueue(send, max_batch_spans=100)
    q.enqueue(entry(None, 250))
    await q.flush()

    assert len(sent) == 1
    assert spans_in(sent[0]) == 250


async def test_drops_oldest_on_overflow_and_warns_once(recwarn):
    sent: List[str] = []
    gate = asyncio.Event()

    async def send(batch):
        sent.extend(e.get("traceId", "anon") for e in batch)
        await gate.wait()

    q = SpanQueue(send, max_queued_spans=5)
    q.enqueue(entry("inflight"))  # taken immediately, so the buffer starts empty
    await asyncio.sleep(0)
    for i in range(8):
        q.enqueue(entry(f"t{i}"))
    gate.set()
    await q.flush()

    assert "t0" not in sent  # oldest dropped
    assert "t2" not in sent
    assert "t3" in sent
    assert "t7" in sent  # newest kept
    assert warning_count(recwarn, "dropping the oldest") == 1


async def test_failure_warns_once_drops_batch_and_keeps_draining(recwarn):
    seen: List[str] = []
    calls = 0

    async def send(batch):
        nonlocal calls
        calls += 1
        if calls <= 2:
            raise RuntimeError("boom")
        seen.extend(e["traceId"] for e in batch)

    q = SpanQueue(send)
    for name in ("a", "b", "c"):
        q.enqueue(entry(name))
        await q.flush()

    assert seen == ["c"]  # a and b were dropped, not retried
    assert warning_count(recwarn, "trace report failed") == 1


async def test_warns_again_for_a_different_error_kind(recwarn):
    calls = 0

    async def send(_batch):
        nonlocal calls
        calls += 1
        raise RuntimeError(f"failure {calls}")

    q = SpanQueue(send)
    for name in ("a", "b"):
        q.enqueue(entry(name))
        await q.flush()

    assert warning_count(recwarn, "trace report failed") == 2


async def test_flush_resolves_when_idle():
    async def send(_batch):
        await asyncio.sleep(0.02)

    q = SpanQueue(send)
    q.enqueue(entry("t1"))
    await q.flush()
    assert q.pending_span_count == 0


async def test_flush_waits_for_spans_enqueued_while_flushing():
    sent: List[List[Dict[str, Any]]] = []

    async def send(batch):
        sent.append(batch)
        await asyncio.sleep(0.01)

    q = SpanQueue(send)
    q.enqueue(entry("t1"))
    flushing = asyncio.ensure_future(q.flush())
    await asyncio.sleep(0)
    q.enqueue(entry("t2"))
    await flushing
    assert trace_ids_of(sent) == ["t1", "t2"]


async def test_enqueue_after_close_discards_and_warns_once(recwarn):
    sent: List[Dict[str, Any]] = []

    async def send(batch):
        sent.extend(batch)

    q = SpanQueue(send)
    await q.close()
    q.enqueue(entry("t1"))
    q.enqueue(entry("t2"))

    assert sent == []
    assert warning_count(recwarn, "after the client was closed") == 1


async def test_close_flushes_and_is_idempotent():
    sent: List[List[Dict[str, Any]]] = []

    async def send(batch):
        sent.append(batch)
        await asyncio.sleep(0.01)

    q = SpanQueue(send)
    q.enqueue(entry("t1"))
    await q.close()
    assert trace_ids_of(sent) == ["t1"]
    await q.close()


async def test_flush_never_raises_even_when_every_send_fails(recwarn):
    async def send(_batch):
        raise RuntimeError("always down")

    q = SpanQueue(send)
    q.enqueue(entry("t1"))
    await q.flush()  # must not raise
    assert warning_count(recwarn, "trace report failed") == 1


async def test_a_cancelled_send_puts_its_batch_back():
    """asyncio.run() cancels pending tasks before closing the loop.

    The batch already taken out of the buffer has to survive that, or the interpreter-exit
    drain would have nothing left to rescue.
    """
    started = asyncio.Event()

    async def send(_batch):
        started.set()
        await asyncio.sleep(10)

    q = SpanQueue(send)
    q.enqueue(entry("t1"))
    await started.wait()
    assert q.pending_span_count == 0  # taken out, in flight

    q._task.cancel()  # what asyncio.run() does at shutdown
    with pytest.raises(asyncio.CancelledError):
        await q._task

    assert q.pending_span_count == 1
    assert q.take_pending()[0]["traceId"] == "t1"


# --- client wiring ---------------------------------------------------------


TRACE_DELAY = 0.4


def _completion(content: str | None, tool_call: Dict[str, str] | None = None) -> Dict[str, Any]:
    """One OpenAI-shaped completion; ``tool_call`` makes the model ask for a tool."""
    message: Dict[str, Any] = {"role": "assistant", "content": content}
    if tool_call:
        message["tool_calls"] = [
            {
                "id": "tc1",
                "type": "function",
                "function": {"name": tool_call["name"], "arguments": tool_call["args"]},
            }
        ]
    return {
        "id": "c1",
        "model": "stub-model",
        "choices": [
            {
                "index": 0,
                "finish_reason": "tool_calls" if tool_call else "stop",
                "message": message,
            }
        ],
        "usage": {"prompt_tokens": 7, "completion_tokens": 1, "total_tokens": 8},
    }


async def test_chat_returns_before_a_slow_trace_post_completes():
    """The regression test for the blocking trace write."""
    import httpx

    import acruxcore as acrux

    trace_posts: List[Dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json=_completion("pong"))
        if request.url.path.endswith("/traces"):
            await asyncio.sleep(TRACE_DELAY)
            trace_posts.append(json.loads(request.content.decode()))
            return httpx.Response(
                200,
                json={"accepted": 1, "traceIds": ["11111111-1111-4111-8111-111111111111"]},
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    async with acrux.AcruxCore(
        api_key="k", base_url="http://stub/api/v1", transport=transport
    ) as hub:
        loop = asyncio.get_running_loop()
        started = loop.time()
        result = await hub.chat(
            "stub-model",
            [{"role": "user", "content": "ping"}],
            provider={"base_url": "http://stub/v1", "api_key": "p"},
        )
        elapsed = loop.time() - started

        assert result.content == "pong"
        assert elapsed < TRACE_DELAY / 2  # the whole bug
        assert trace_posts == []  # in flight, not yet answered

        await hub.flush()
        assert len(trace_posts) == 1  # nothing lost
        assert len(trace_posts[0]["traces"][0]["spans"]) == 1


async def test_tool_loop_with_client_side_tools_awaits_no_trace_write():
    import httpx

    import acruxcore as acrux

    rounds = 0
    trace_posts = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal rounds, trace_posts
        if request.url.path.endswith("/chat/completions"):
            rounds += 1
            body = (
                _completion(None, {"name": "add", "args": '{"a": 2, "b": 3}'})
                if rounds == 1
                else _completion("5")
            )
            return httpx.Response(200, json=body)
        if request.url.path.endswith("/traces"):
            trace_posts += 1
            await asyncio.sleep(TRACE_DELAY)
            return httpx.Response(
                200,
                json={"accepted": 1, "traceIds": ["11111111-1111-4111-8111-111111111111"]},
            )
        return httpx.Response(404)

    @acrux.tool(
        name="add",
        description="Adds two numbers.",
        parameters={
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    )
    async def add(a: float, b: float) -> str:
        return str(a + b)

    transport = httpx.MockTransport(handler)
    async with acrux.AcruxCore(
        api_key="k", base_url="http://stub/api/v1", transport=transport
    ) as hub:
        loop = asyncio.get_running_loop()
        started = loop.time()
        result = await hub.run_tool_loop(
            "stub-model",
            [{"role": "user", "content": "what is 2 + 3?"}],
            tools=[add],
            # A declared tool would otherwise sync itself to the catalog first, and the
            # stub answers that route slowly too — a round-trip this test is not measuring.
            sync=False,
            provider={"base_url": "http://stub/v1", "api_key": "p"},
        )
        elapsed = loop.time() - started

        assert result.content == "5"
        assert elapsed < TRACE_DELAY / 2  # two llm spans + tool spans, none awaited

        await hub.flush()
        assert trace_posts >= 1


async def test_a_failed_trace_report_never_surfaces_in_chat(recwarn):
    import httpx

    import acruxcore as acrux

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json=_completion("still fine"))
        return httpx.Response(400, json={"error": {"code": "INVALID_SPAN_PARENT"}})

    transport = httpx.MockTransport(handler)
    async with acrux.AcruxCore(
        api_key="k", base_url="http://stub/api/v1", transport=transport, max_retries=0
    ) as hub:
        result = await hub.chat(
            "stub-model",
            [{"role": "user", "content": "hi"}],
            provider={"base_url": "http://stub/v1", "api_key": "p"},
        )
        assert result.content == "still fine"
        await hub.flush()

    assert warning_count(recwarn, "trace report failed") == 1


async def test_public_trace_still_awaits_and_returns_a_trace_id():
    import httpx

    import acruxcore as acrux

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"accepted": 1, "traceIds": ["22222222-2222-4222-8222-222222222222"]}
        )

    transport = httpx.MockTransport(handler)
    async with acrux.AcruxCore(
        api_key="k", base_url="http://stub/api/v1", transport=transport
    ) as hub:
        result = await hub.trace(
            {
                "name": "manual",
                "spans": [
                    {
                        "spanId": "s1",
                        "name": "retrieval",
                        "kind": "retrieval",
                        "status": "ok",
                        "startTime": "2026-07-30T00:00:00.000Z",
                        "endTime": "2026-07-30T00:00:00.000Z",
                    }
                ],
            }
        )
        assert result.trace_id == "22222222-2222-4222-8222-222222222222"


def test_script_that_exits_without_aclose_still_delivers_its_trace():
    """Runs a fixture as a real subprocess against one throwaway HTTP server.

    ``atexit`` cannot be exercised in-process: pytest's interpreter does not exit, and the
    handler's whole job is to drain on a fresh event loop after the caller's loop closed.
    """
    import http.server
    import threading

    received: List[bytes] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 — http.server's own naming
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.path.endswith("/traces"):
                received.append(body)
                payload: Dict[str, Any] = {
                    "accepted": 1,
                    "traceIds": ["33333333-3333-4333-8333-333333333333"],
                }
            else:
                payload = _completion("pong")
            raw = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_args):  # keep pytest output clean
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]

    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).parent / "exit_flush_fixture.py")],
            capture_output=True,
            text=True,
            timeout=60,
            env={
                **os.environ,
                "FIXTURE_BASE_URL": f"http://127.0.0.1:{port}/api/v1",
                "FIXTURE_PROVIDER_URL": f"http://127.0.0.1:{port}/v1",
                "FIXTURE_API_KEY": "k",
            },
        )
    finally:
        server.shutdown()

    assert result.stdout == "done", result.stderr
    assert len(received) == 1, f"atexit did not drain the queue: {result.stderr}"
