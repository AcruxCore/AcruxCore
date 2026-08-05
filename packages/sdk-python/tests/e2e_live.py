"""Live end-to-end test of the Acrux Core Python SDK.

Runs against a real local API (apps/api on :3001) and real OpenRouter LLM calls.
Exercises every public method: render_prompt (+cache), chat, streaming chat,
run_tool_loop (real tool-calling loop with trace threading), trace, get_trace,
list_traces, submit_feedback, update_feedback.

Requires ACRUXCORE_API_KEY and ACRUXCORE_BASE_URL in the environment.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

from acruxcore import AcruxCore, AcruxCoreError, acrux

MODEL = "gpt-4o-mini"
PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"

failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    print(f"  [{PASS if cond else FAIL}] {label}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(label)


async def main() -> None:
    hub = AcruxCore()  # reads env
    try:
        print("\n=== 1. render_prompt (real render, nunjucks var) ===")
        rendered = await hub.prompts.render("py-sdk-weather", "production", {"city": "Tokyo"})
        text = " ".join(m.get("content") or "" for m in rendered.messages)
        check("render returns messages", len(rendered.messages) >= 2, f"{len(rendered.messages)} msgs")
        check("template variable substituted", "Tokyo" in text, repr(text[:80]))

        print("\n=== 2. render_prompt cache (2nd call served from cache) ===")
        t0 = asyncio.get_event_loop().time()
        await hub.prompts.render("py-sdk-weather", "production", {"city": "Tokyo"})
        dt = (asyncio.get_event_loop().time() - t0) * 1000
        check("cached render is fast (<5ms)", dt < 5, f"{dt:.2f}ms")

        print("\n=== 3. chat (real OpenRouter completion) ===")
        r = await hub.gateway.chat(MODEL, [{"role": "user", "content": "Reply with exactly one word: ping"}])
        check("chat returns content", bool(r.content), repr((r.content or "")[:60]))
        check("finish_reason present", r.finish_reason is not None, str(r.finish_reason))
        check("usage populated", r.usage is not None and (r.usage.total_tokens or 0) > 0,
              str(r.usage.total_tokens if r.usage else None))
        check("gateway meta: provider", r.gateway.provider is not None, str(r.gateway.provider))
        check("gateway meta: request_id", r.gateway.request_id is not None, str(r.gateway.request_id))

        print("\n=== 4. chat streaming (real SSE) ===")
        chunks = 0
        streamed = ""
        finish = None
        async for chunk in await hub.gateway.stream(
            MODEL, [{"role": "user", "content": "Count: one two three"}]
        ):
            chunks += 1
            streamed += chunk.delta.get("content", "") or ""
            if chunk.finish_reason:
                finish = chunk.finish_reason
        check("received stream chunks", chunks > 0, f"{chunks} chunks")
        check("streamed text non-empty", len(streamed) > 0, repr(streamed[:60]))
        check("stream ended with finish_reason", finish is not None, str(finish))

        print("\n=== 5. run_tool_loop (real tool-calling loop + tracing) ===")
        tools = [{
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
        }]
        dispatched: list[str] = []

        async def dispatch(name: str, args: dict):
            dispatched.append(name)
            if name == "get_weather":
                return {"city": args.get("city"), "tempC": 21, "condition": "sunny"}
            raise ValueError(f"unknown tool {name}")

        loop_res = await hub.gateway.run_tool_loop(
            MODEL,
            [
                {"role": "system", "content": "You are a weather bot. Use get_weather, then answer in one sentence."},
                {"role": "user", "content": "What's the weather in Paris?"},
            ],
            dispatch=dispatch,
            tool_defs=tools,
            trace={"name": "py-sdk-e2e-weather", "session_id": "py-sdk-e2e"},
        )
        check("tool was dispatched", "get_weather" in dispatched, str(dispatched))
        check("loop produced final content", bool(loop_res.content), repr((loop_res.content or "")[:80]))
        check("loop took >=2 iterations", loop_res.iterations >= 2, f"{loop_res.iterations}")
        check("loop not stopped at limit", loop_res.stopped_at_limit is False)
        check("loop returned a trace_id", loop_res.trace_id is not None, str(loop_res.trace_id))
        trace_id = loop_res.trace_id

        print("\n=== 6. get_trace (verify one trace: llm spans + tool span threaded) ===")
        await asyncio.sleep(1.0)  # let async span ingest settle
        detail = await hub.traces.get(trace_id)

        def flatten(spans):
            out = []
            for s in spans:
                out.append(s)
                out.extend(flatten(s.children))
            return out

        all_spans = flatten(detail.spans)
        kinds = [s.kind for s in all_spans]
        llm_spans = [s for s in all_spans if s.kind == "llm"]
        tool_spans = [s for s in all_spans if s.kind == "tool"]
        check("trace has llm span(s) (gateway-owned)", len(llm_spans) >= 1, f"{len(llm_spans)} llm")
        check("trace has the tool span (SDK-reported)", len(tool_spans) >= 1, f"{len(tool_spans)} tool")
        check("tool span named get_weather", any(s.name == "get_weather" for s in tool_spans),
              str([s.name for s in tool_spans]))
        # The tool span should be parented to an llm span (threading worked → one trace).
        llm_ids = {s.span_id for s in llm_spans}
        parented = any(s.parent_span_id in llm_ids for s in tool_spans)
        check("tool span parented to an llm span (single-trace threading)", parented,
              f"tool.parent={[s.parent_span_id for s in tool_spans]} llm_ids={llm_ids}")
        print(f"    span kinds in trace: {kinds}")

        print("\n=== 6b. @acrux.tool loop (sync → resolve-free → local run → trace) ===")
        # The decorated path, end to end: the decorator derives the schema, the loop
        # syncs it to the catalog, sends a tool_ref rather than an inline schema, and
        # runs the Python function itself.
        echoed: list[str] = []

        @acrux.tool
        def echo_city(city: str) -> dict:
            """Return the city it was given, so the assertion needs no external service.

            Args:
                city: Any city name.
            """
            echoed.append(city)
            return {"city": city}

        dec_res = await hub.gateway.run_tool_loop(
            model=MODEL,
            messages=[
                {"role": "system", "content": "Use echo_city, then state the city name."},
                {"role": "user", "content": "Call echo_city with London."},
            ],
            tools=[echo_city],
            trace={"name": "py-sdk-e2e-decorated"},
        )
        check("decorated tool actually ran", echoed == ["London"], str(echoed))
        check("decorated loop produced content", bool(dec_res.content), repr((dec_res.content or "")[:80]))
        check("decorated loop returned a trace_id", dec_res.trace_id is not None, str(dec_res.trace_id))

        await asyncio.sleep(1.0)  # let async span ingest settle
        dec_trace = await hub.traces.get(dec_res.trace_id)
        dec_spans = flatten(dec_trace.spans)
        dec_kinds = [s.kind for s in dec_spans]
        dec_tool_spans = [s for s in dec_spans if s.kind == "tool"]
        check("exactly one tool span", len(dec_tool_spans) == 1, str(dec_kinds))
        check("at least one llm span", dec_kinds.count("llm") >= 1, str(dec_kinds))
        if dec_tool_spans:
            attrs = dec_tool_spans[0].attributes or {}
            # The gap this closes: a tool span used to carry only {"arguments": ...},
            # so a trace could not say which version of the tool ran.
            check("tool span records executorType", attrs.get("executorType") == "client",
                  str(attrs.get("executorType")))
            check("tool span names the version that ran", bool(attrs.get("toolVersionId")),
                  str(attrs.get("toolVersionId")))

        print("\n=== 7. list_traces (newest first, find the loop's trace) ===")
        # NOTE: run_tool_loop now sends x-session-id too, so the gateway stamps the
        # session on the trace at creation — the loop's trace is grouped under the
        # session_id passed above. Session filtering is also exercised in step 8
        # against the manual trace, which sets sessionId at creation.
        listed = await hub.traces.list(limit=20)
        check("list_traces returns traces", listed.total >= 1, f"total={listed.total}")
        check("list_traces includes the loop trace", any(t.id == trace_id for t in listed.data),
              f"ids={[t.id for t in listed.data][:5]}")

        print("\n=== 8. trace() manual write + read back + session filter ===")
        now = datetime.now(timezone.utc).isoformat()
        tw = await hub.traces.ingest({
            "name": "py-sdk-manual-trace",
            "sessionId": "py-sdk-e2e",
            "spans": [
                {"spanId": "m1", "name": "retrieve", "kind": "retrieval", "startTime": now, "endTime": now,
                 "attributes": {"query": "weather"}},
                {"spanId": "m2", "parentSpanId": "m1", "name": "rank", "kind": "chain", "startTime": now, "endTime": now},
            ],
        })
        check("manual trace created", tw.trace_id is not None, tw.trace_id)
        man = await hub.traces.get(tw.trace_id)
        check("manual trace has 2 spans", len(flatten(man.spans)) == 2, f"{len(flatten(man.spans))}")
        by_session = await hub.traces.list(session_id="py-sdk-e2e", limit=10)
        check("list_traces session filter finds manual trace",
              any(t.id == tw.trace_id for t in by_session.data), f"total={by_session.total}")

        print("\n=== 9. submit_feedback + update_feedback ===")
        fb = await hub.traces.submit_feedback(trace_id, rating=5, label="good", comment="worked", source="developer")
        check("feedback created", fb.id is not None, fb.id)
        check("feedback rating stored", fb.rating == 5, str(fb.rating))
        upd = await hub.traces.update_feedback(trace_id, fb.id, rating=1, comment="revised")
        check("feedback updated rating", upd.rating == 1, str(upd.rating))
        check("feedback updated comment", upd.comment == "revised", str(upd.comment))

        print("\n=== 10. error handling (missing prompt -> API_ERROR 404) ===")
        try:
            await hub.prompts.render("does-not-exist-xyz", "production", {})
            check("missing prompt raises", False, "no error raised")
        except AcruxCoreError as e:
            check("missing prompt -> API_ERROR", e.code == "API_ERROR", f"{e.code}/{e.status_code}")

    finally:
        await hub.gateway.aclose()

    print("\n" + "=" * 60)
    if failures:
        print(f"{FAIL}: {len(failures)} check(s) failed: {failures}")
        raise SystemExit(1)
    print(f"{PASS}: all live e2e checks passed 🎉")


if __name__ == "__main__":
    asyncio.run(main())
