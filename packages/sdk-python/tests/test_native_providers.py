"""BYO calls in the native Anthropic and Gemini formats.

The provider is the one thing replaced here (a paid third party), by an httpx mock that
records each request and answers with the provider's real wire shape. Everything between
— body building, translation, the tool loop, span reporting — is the SDK's real code.
"""

from __future__ import annotations

import json
import warnings
from typing import Any, Callable, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError

WEATHER_TOOL = [{"type": "function", "function": {
    "name": "get_weather", "description": "Weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}}]
ANTHROPIC = {"kind": "anthropic", "api_key": "sk-ant"}
GEMINI = {"kind": "gemini", "api_key": "g-key"}


def client(handler: Callable[[httpx.Request], httpx.Response]) -> AcruxCore:
    return AcruxCore(api_key="acx", base_url="http://localhost:3000/api/v1",
                     transport=httpx.MockTransport(handler), max_retries=0, retry_interval=1)


def sse(events: List[Dict[str, Any]], *, named: bool, crlf: bool = False) -> bytes:
    nl = "\r\n" if crlf else "\n"
    frames = []
    for e in events:
        head = f"event: {e['type']}{nl}" if named else ""
        frames.append(f"{head}data: {json.dumps(e)}{nl}{nl}")
    return "".join(frames).encode()


# ── Anthropic ──────────────────────────────────────────────────────────────


async def test_anthropic_chat_sends_the_messages_api_and_reads_its_reply():
    sent: List[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={
            "id": "msg_1", "model": "claude-haiku-4-5", "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "Hello."}],
            "usage": {"input_tokens": 10, "output_tokens": 3, "cache_read_input_tokens": 90},
        })

    async with client(handler) as c:
        r = await c.gateway.chat("claude-haiku-4-5", [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": "hi"},
        ], provider=ANTHROPIC, trace=False, temperature=0)

    req = sent[0]
    assert str(req.url) == "https://api.anthropic.com/v1/messages"
    assert req.headers["x-api-key"] == "sk-ant"
    assert req.headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in req.headers
    body = json.loads(req.content)
    assert body == {"model": "claude-haiku-4-5", "system": "Be brief.", "max_tokens": 1024,
                    "temperature": 0, "messages": [{"role": "user", "content": "hi"}]}
    assert r.content == "Hello."
    assert r.finish_reason == "stop"
    # Anthropic's input_tokens leaves the cache read out; prompt_tokens puts it back.
    assert (r.usage.prompt_tokens, r.usage.completion_tokens, r.usage.cached_tokens) == (100, 3, 90)
    assert r.gateway.provider == "api.anthropic.com"


async def test_anthropic_tool_loop_sends_parallel_results_in_one_user_turn():
    bodies: List[Dict[str, Any]] = []
    replies = [
        {"id": "m1", "model": "claude", "stop_reason": "tool_use", "usage": {"input_tokens": 5, "output_tokens": 5},
         "content": [{"type": "text", "text": "Checking."},
                     {"type": "tool_use", "id": "tu_1", "name": "get_weather", "input": {"city": "Paris"}},
                     {"type": "tool_use", "id": "tu_2", "name": "get_weather", "input": {"city": "Rome"}}]},
        {"id": "m2", "model": "claude", "stop_reason": "end_turn", "usage": {"input_tokens": 9, "output_tokens": 4},
         "content": [{"type": "text", "text": "Paris 18, Rome 24."}]},
    ]

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json=replies[len(bodies) - 1])

    async with client(handler) as c:
        r = await c.gateway.run_tool_loop(
            "claude", [{"role": "user", "content": "weather?"}], tool_defs=WEATHER_TOOL,
            dispatch=lambda name, args: {"temp": 18 if args["city"] == "Paris" else 24},
            provider=ANTHROPIC, trace=False,
        )

    assert r.content == "Paris 18, Rome 24."
    assert bodies[0]["tools"] == [{"name": "get_weather", "description": "Weather for a city",
                                   "input_schema": WEATHER_TOOL[0]["function"]["parameters"]}]
    second = bodies[1]["messages"]
    assert second[1] == {"role": "assistant", "content": [
        {"type": "text", "text": "Checking."},
        {"type": "tool_use", "id": "tu_1", "name": "get_weather", "input": {"city": "Paris"}},
        {"type": "tool_use", "id": "tu_2", "name": "get_weather", "input": {"city": "Rome"}},
    ]}
    assert second[2] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "tu_1", "content": '{"temp": 18}'},
        {"type": "tool_result", "tool_use_id": "tu_2", "content": '{"temp": 24}'},
    ]}
    assert len(second) == 3


async def test_anthropic_stream_tool_loop_and_span():
    """A streamed tool loop: round one streams a tool_use, round two streams text. The
    llm span for each round carries the translated usage."""
    rounds = [
        [{"type": "message_start", "message": {"id": "m1", "model": "claude-x", "usage": {"input_tokens": 20, "output_tokens": 1}}},
         {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
         {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Let me check."}},
         {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "tu_9", "name": "get_weather", "input": {}}},
         {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"city": '}},
         {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '"Paris"}'}},
         {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 12}},
         {"type": "message_stop"}],
        [{"type": "message_start", "message": {"id": "m2", "model": "claude-x", "usage": {"input_tokens": 40}}},
         {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "It is 18C."}},
         {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5}},
         {"type": "message_stop"}],
    ]
    bodies: List[Dict[str, Any]] = []
    traces: List[Dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/traces"):
            traces.extend(json.loads(req.content)["traces"])
            return httpx.Response(200, json={"data": []})
        bodies.append(json.loads(req.content))
        return httpx.Response(200, content=sse(rounds[len(bodies) - 1], named=True),
                              headers={"content-type": "text/event-stream"})

    events = []
    async with client(handler) as c:
        stream = await c.gateway.run_tool_loop(
            "claude-x", [{"role": "user", "content": "weather in Paris?"}], tool_defs=WEATHER_TOOL,
            dispatch=lambda name, args: {"temp": 18}, provider=ANTHROPIC, stream=True,
        )
        async for ev in stream:
            events.append(ev)
        await c.gateway.flush()

    assert bodies[0]["stream"] is True and "stream_options" not in bodies[0]
    assert bodies[1]["messages"][1]["content"][1] == {
        "type": "tool_use", "id": "tu_9", "name": "get_weather", "input": {"city": "Paris"}}
    calls = [e for e in events if type(e).__name__ == "ToolLoopToolCallEvent"]
    assert [(c.id, c.arguments) for c in calls] == [("tu_9", {"city": "Paris"})]
    assert events[-1].result.content == "It is 18C."
    llm = [s for t in traces for s in t["spans"] if s["kind"] == "llm"]
    assert [s["usage"] for s in llm] == [
        {"promptTokens": 20, "completionTokens": 12, "totalTokens": 32},
        {"promptTokens": 40, "completionTokens": 5, "totalTokens": 45},
    ]
    assert llm[0]["provider"] == "api.anthropic.com"


async def test_anthropic_response_format_is_a_forced_tool_returned_as_json():
    sent: List[Dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={
            "id": "m", "model": "claude", "stop_reason": "tool_use", "usage": {"input_tokens": 1, "output_tokens": 1},
            "content": [{"type": "tool_use", "id": "t", "name": "capital", "input": {"capital": "Paris"}}],
        })

    rf = {"type": "json_schema", "json_schema": {"name": "capital", "schema": {"type": "object"}}}
    async with client(handler) as c:
        r = await c.gateway.chat("claude", [{"role": "user", "content": "France?"}],
                                 provider=ANTHROPIC, trace=False, response_format=rf)
    assert sent[0]["tool_choice"] == {"type": "tool", "name": "capital"}
    assert json.loads(r.content) == {"capital": "Paris"}
    assert r.finish_reason == "stop"
    assert "tool_calls" not in r.message


# ── Gemini ─────────────────────────────────────────────────────────────────


async def test_gemini_tool_loop_sends_the_thought_signature_back():
    """Gemini 3 refuses a follow-up turn whose function call lost its thoughtSignature,
    so it must come back on the next request, with the call id and the function name."""
    sent: List[httpx.Request] = []
    replies = [
        {"responseId": "r1", "modelVersion": "gemini-3.5-flash",
         "candidates": [{"finishReason": "STOP", "content": {"role": "model", "parts": [
             {"functionCall": {"id": "call_1", "name": "get_weather", "args": {"city": "Paris"}}, "thoughtSignature": "SIG1"},
             {"functionCall": {"id": "call_2", "name": "get_weather", "args": {"city": "Rome"}}},
         ]}}],
         "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 10, "thoughtsTokenCount": 30, "totalTokenCount": 90}},
        {"responseId": "r2", "modelVersion": "gemini-3.5-flash",
         "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "Both mild."}]}}],
         "usageMetadata": {"promptTokenCount": 80, "candidatesTokenCount": 3, "totalTokenCount": 83}},
    ]

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json=replies[len(sent) - 1])

    async with client(handler) as c:
        r = await c.gateway.run_tool_loop(
            "gemini-3.5-flash", [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "weather?"}],
            tool_defs=WEATHER_TOOL, dispatch=lambda name, args: {"temp": 20}, provider=GEMINI, trace=False,
        )

    assert str(sent[0].url) == (
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent")
    assert sent[0].headers["x-goog-api-key"] == "g-key"
    first = json.loads(sent[0].content)
    assert first["systemInstruction"] == {"parts": [{"text": "Be brief."}]}
    assert first["tools"][0]["functionDeclarations"][0]["name"] == "get_weather"
    contents = json.loads(sent[1].content)["contents"]
    assert contents[1] == {"role": "model", "parts": [
        {"functionCall": {"name": "get_weather", "args": {"city": "Paris"}, "id": "call_1"}, "thoughtSignature": "SIG1"},
        {"functionCall": {"name": "get_weather", "args": {"city": "Rome"}, "id": "call_2"}},
    ]}
    assert contents[2] == {"role": "user", "parts": [
        {"functionResponse": {"name": "get_weather", "response": {"temp": 20}, "id": "call_1"}},
        {"functionResponse": {"name": "get_weather", "response": {"temp": 20}, "id": "call_2"}},
    ]}
    assert r.content == "Both mild."
    assistant = r.messages[2]
    assert assistant["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": "SIG1"}}


async def test_gemini_usage_counts_thinking_as_completion():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "candidates": [{"finishReason": "STOP", "content": {"parts": [
                {"text": "plan", "thought": True}, {"text": "Answer."}]}}],
            "usageMetadata": {"promptTokenCount": 8, "candidatesTokenCount": 2, "thoughtsTokenCount": 40,
                              "cachedContentTokenCount": 4, "totalTokenCount": 50},
        })

    async with client(handler) as c:
        r = await c.gateway.chat("gemini-3.5-flash", [{"role": "user", "content": "q"}], provider=GEMINI, trace=False)
    assert r.content == "Answer."
    assert (r.usage.prompt_tokens, r.usage.completion_tokens, r.usage.total_tokens) == (8, 42, 50)
    assert (r.usage.reasoning_tokens, r.usage.cached_tokens) == (40, 4)


async def test_gemini_stream_reads_crlf_frames_with_no_done_marker():
    frames = [
        {"candidates": [{"content": {"parts": [{"text": "1, 2"}]}}]},
        {"candidates": [{"content": {"parts": [{"text": ", 3"}]}, "finishReason": "STOP"}],
         "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 6, "totalTokenCount": 10}},
    ]
    urls: List[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        urls.append(str(req.url))
        return httpx.Response(200, content=sse(frames, named=False, crlf=True),
                              headers={"content-type": "text/event-stream"})

    async with client(handler) as c:
        text, finish = "", None
        async for chunk in await c.gateway.chat("gemini-3.5-flash", [{"role": "user", "content": "count"}],
                                                provider=GEMINI, trace=False, stream=True):
            text += chunk.delta.get("content") or ""
            finish = chunk.finish_reason or finish
    assert urls[0].endswith("/models/gemini-3.5-flash:streamGenerateContent?alt=sse")
    assert (text, finish) == ("1, 2, 3", "stop")


async def test_gemini_extra_body_merges_into_generation_config_and_clashes_are_refused():
    sent: List[Dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "ok"}]}}]})

    msgs = [{"role": "user", "content": "q"}]
    async with client(handler) as c:
        await c.gateway.chat("gemini-3.5-flash", msgs, provider=GEMINI, trace=False, temperature=0.2,
                             extra_body={"generationConfig": {"thinkingConfig": {"thinkingLevel": "low"}}})
        with pytest.raises(AcruxCoreError) as exc:
            await c.gateway.chat("gemini-3.5-flash", msgs, provider=GEMINI, trace=False, temperature=0.2,
                                 extra_body={"generationConfig": {"temperature": 1}})
    assert sent[0]["generationConfig"] == {"temperature": 0.2, "thinkingConfig": {"thinkingLevel": "low"}}
    assert exc.value.code == "VALIDATION_ERROR"
    assert len(sent) == 1


# ── kind resolution ────────────────────────────────────────────────────────


@pytest.mark.parametrize("base_url,expected_url", [
    ("https://api.anthropic.com/v1/", "https://api.anthropic.com/v1/messages"),
    ("https://generativelanguage.googleapis.com/v1beta",
     "https://generativelanguage.googleapis.com/v1beta/models/m:generateContent"),
    ("https://generativelanguage.googleapis.com/v1beta/openai",
     "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"),
    ("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/chat/completions"),
])
async def test_the_host_picks_the_format_when_kind_is_left_out(base_url: str, expected_url: str):
    urls: List[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        urls.append(str(req.url))
        return httpx.Response(500, json={"error": "stop here"})

    async with client(handler) as c:
        with pytest.raises(AcruxCoreError):
            await c.gateway.chat("m", [{"role": "user", "content": "q"}],
                                 provider={"base_url": base_url, "api_key": "k"}, trace=False)
    assert urls == [expected_url]


async def test_base_url_is_still_required_for_an_openai_compatible_kind():
    async with client(lambda r: httpx.Response(500)) as c:
        with pytest.raises(AcruxCoreError) as exc:
            await c.gateway.chat("m", [{"role": "user", "content": "q"}],
                                 provider={"kind": "openai_compatible", "api_key": "k"}, trace=False)
    assert exc.value.code == "MISSING_BASE_URL"


async def test_reasoning_effort_is_not_sent_to_a_native_provider_and_says_so():
    sent: List[Dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={"id": "m", "model": "c", "stop_reason": "end_turn",
                                         "content": [{"type": "text", "text": "ok"}], "usage": {}})

    async with client(handler) as c:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            await c.gateway.chat("c", [{"role": "user", "content": "q"}], provider=ANTHROPIC,
                                 trace=False, reasoning_effort="high")
    assert "reasoning_effort" not in sent[0]
    assert any("reasoning_effort is not sent" in str(w.message) for w in caught)


async def test_gemini_tool_schema_goes_in_parameters_json_schema() -> None:
    """Gemini's `parameters` field is an OpenAPI subset that rejects `additionalProperties`
    with a 400. `parametersJsonSchema` takes full JSON Schema, so a schema from zod or
    pydantic reaches the model as it is."""
    sent: List[httpx.Request] = []
    schema = {"type": "object", "properties": {"city": {"type": "string"}},
              "required": ["city"], "additionalProperties": False}

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "ok"}]}}]})

    async with client(handler) as c:
        await c.gateway.chat(
            "gemini-3.5-flash", [{"role": "user", "content": "weather?"}],
            tools=[{"type": "function", "function": {"name": "get_weather", "parameters": schema}}],
            provider=GEMINI, trace=False,
        )

    decl = json.loads(sent[0].content)["tools"][0]["functionDeclarations"][0]
    assert decl == {"name": "get_weather", "parametersJsonSchema": schema}


# ── PR #827 review findings ────────────────────────────────────────────────


async def test_gemini_stream_survives_a_crlf_split_across_two_network_chunks():
    """Gemini ends SSE lines with CRLF. A network read can end between the \\r and the
    \\n, so line endings must be normalized on the buffer, not on each chunk."""
    f1 = 'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\r\n\r\n'
    f2 = ('data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],'
          '"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\r\n\r\n')
    raw = (f1 + f2).encode()
    cut = len(f1) - 1  # the first read ends with "\r\n\r", the second starts with "\n"

    class Split(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield raw[:cut]
            yield raw[cut:]

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Split(), headers={"content-type": "text/event-stream"})

    async with client(handler) as c:
        text = ""
        async for chunk in await c.gateway.chat("gemini-3.5-flash", [{"role": "user", "content": "hi"}],
                                                provider=GEMINI, trace=False, stream=True):
            text += chunk.delta.get("content") or ""
    assert text == "Hello"


THINKING = {"type": "thinking", "thinking": "Need the weather.", "signature": "SIG-A"}
REDACTED = {"type": "redacted_thinking", "data": "ENC"}


async def test_anthropic_chat_sends_thinking_blocks_back_before_tool_use():
    """With extended thinking on, Anthropic requires the turn's thinking blocks, unchanged
    and with their signatures, before the tool_use on the next request. They ride on the
    first tool call's ``extra_content``, so appending ``r.message`` is enough."""
    replies = [
        {"id": "m1", "model": "claude-x", "stop_reason": "tool_use", "usage": {"input_tokens": 5, "output_tokens": 5},
         "content": [THINKING, REDACTED,
                     {"type": "tool_use", "id": "tu_1", "name": "get_weather", "input": {"city": "Paris"}}]},
        {"id": "m2", "model": "claude-x", "stop_reason": "end_turn", "usage": {"input_tokens": 9, "output_tokens": 2},
         "content": [{"type": "text", "text": "Mild."}]},
    ]
    bodies: List[Dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json=replies[len(bodies) - 1])

    thinking = {"thinking": {"type": "enabled", "budget_tokens": 1024}}
    msgs: List[Any] = [{"role": "user", "content": "weather?"}]
    async with client(handler) as c:
        r = await c.gateway.chat("claude-x", msgs, tools=WEATHER_TOOL, provider=ANTHROPIC,
                                 trace=False, extra_body=thinking)
        msgs += [r.message, {"role": "tool", "tool_call_id": "tu_1", "content": '{"temp": 18}'}]
        r2 = await c.gateway.chat("claude-x", msgs, tools=WEATHER_TOOL, provider=ANTHROPIC,
                                  trace=False, extra_body=thinking)
    assert bodies[1]["messages"][1]["content"] == [
        THINKING, REDACTED,
        {"type": "tool_use", "id": "tu_1", "name": "get_weather", "input": {"city": "Paris"}},
    ]
    assert r2.content == "Mild."


async def test_anthropic_stream_puts_streamed_thinking_on_the_first_tool_call():
    events = [
        {"type": "message_start", "message": {"id": "m1", "model": "claude-x", "usage": {"input_tokens": 5}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Need the "}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "weather."}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "SIG-A"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": REDACTED},
        {"type": "content_block_stop", "index": 1},
        {"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "tu_1", "name": "get_weather", "input": {}}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '{"city": "Paris"}'}},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}},
        {"type": "message_stop"},
    ]

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse(events, named=True), headers={"content-type": "text/event-stream"})

    deltas: List[Dict[str, Any]] = []
    async with client(handler) as c:
        async for chunk in await c.gateway.chat("claude-x", [{"role": "user", "content": "weather?"}],
                                                tools=WEATHER_TOOL, provider=ANTHROPIC, trace=False, stream=True,
                                                extra_body={"thinking": {"type": "enabled", "budget_tokens": 1024}}):
            deltas += chunk.delta.get("tool_calls") or []
    first = deltas[0]
    assert first["id"] == "tu_1"
    assert first["extra_content"] == {"anthropic": {"thinking_blocks": [THINKING, REDACTED]}}


async def test_gemini_leaves_an_sdk_made_id_off_the_function_response_too():
    """Gemini sent no id, so the SDK made one up (acx_…). It goes on neither part."""
    replies = [
        {"candidates": [{"finishReason": "STOP", "content": {"role": "model", "parts": [
            {"functionCall": {"name": "get_weather", "args": {"city": "Paris"}}}]}}]},
        {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "Mild."}]}}]},
    ]
    bodies: List[Dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(200, json=replies[len(bodies) - 1])

    async with client(handler) as c:
        await c.gateway.run_tool_loop("gemini-3.5-flash", [{"role": "user", "content": "weather?"}],
                                      tool_defs=WEATHER_TOOL, dispatch=lambda name, args: {"temp": 18},
                                      provider=GEMINI, trace=False)
    contents = bodies[1]["contents"]
    assert contents[1]["parts"][0]["functionCall"] == {"name": "get_weather", "args": {"city": "Paris"}}
    assert contents[2]["parts"][0]["functionResponse"] == {"name": "get_weather", "response": {"temp": 18}}


async def test_max_completion_tokens_is_sent_as_the_native_output_limit():
    sent: List[Dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content))
        if "anthropic" in str(req.url):
            return httpx.Response(200, json={"id": "m", "model": "c", "stop_reason": "end_turn",
                                             "usage": {"input_tokens": 1, "output_tokens": 1},
                                             "content": [{"type": "text", "text": "ok"}]})
        return httpx.Response(200, json={"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "ok"}]}}]})

    msgs = [{"role": "user", "content": "q"}]
    async with client(handler) as c:
        await c.gateway.chat("claude-x", msgs, provider=ANTHROPIC, trace=False,
                             extra_body={"max_completion_tokens": 4000})
        await c.gateway.chat("gemini-3.5-flash", msgs, provider=GEMINI, trace=False,
                             extra_body={"max_completion_tokens": 4000})
    assert sent[0]["max_tokens"] == 4000
    assert sent[1]["generationConfig"]["maxOutputTokens"] == 4000
