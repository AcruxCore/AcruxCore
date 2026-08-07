"""Unit tests for the AcruxCore Python SDK.

Every test drives the real client through a mocked httpx transport — no network,
but the full request-building / response-parsing / retry / cache / tool-loop code
runs exactly as it would against the live API.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError, pydantic_response_format
from acruxcore.cache import _reset_cache_for_testing
from acruxcore.response_format import _strict_for_openai

# pydantic_response_format() itself needs no pydantic import; the *conversion* (at send
# time) does. Tests that exercise the pydantic path skip individually when pydantic is
# absent, so the rest of the suite still runs without it installed.
has_pydantic = True
try:
    import pydantic  # noqa: F401
except ImportError:  # pragma: no cover
    has_pydantic = False
pydantic_required = pytest.mark.skipif(not has_pydantic, reason="pydantic not installed")


@pytest.fixture(autouse=True)
def _reset_cache():
    _reset_cache_for_testing()
    yield
    _reset_cache_for_testing()


def make_client(handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any) -> AcruxCore:
    """Build a client whose HTTP goes through ``handler`` instead of the network."""
    transport = httpx.MockTransport(handler)
    return AcruxCore(
        api_key="test-key",
        base_url="http://localhost:3000/api/v1",
        transport=transport,
        retry_interval=1,  # keep retry tests fast
        **kwargs,
    )


def body_of(request: httpx.Request) -> Dict[str, Any]:
    return json.loads(request.content.decode("utf-8")) if request.content else {}


# --- constructor -----------------------------------------------------------


def test_missing_api_key(monkeypatch):
    monkeypatch.delenv("ACRUXCORE_API_KEY", raising=False)
    with pytest.raises(AcruxCoreError) as ei:
        AcruxCore(base_url="http://x/api/v1")
    assert ei.value.code == "MISSING_API_KEY"


def test_missing_base_url(monkeypatch):
    monkeypatch.delenv("ACRUXCORE_BASE_URL", raising=False)
    with pytest.raises(AcruxCoreError) as ei:
        AcruxCore(api_key="k")
    assert ei.value.code == "MISSING_BASE_URL"


def test_base_url_trailing_slash_stripped():
    c = AcruxCore(api_key="k", base_url="http://x/api/v1///", transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert c._base_url == "http://x/api/v1"


# --- render_prompt ---------------------------------------------------------


async def test_render_prompt_basic_and_auth():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        seen["path"] = request.url.path
        seen["body"] = body_of(request)
        return httpx.Response(200, json={"messages": [{"role": "system", "content": "Hi Alice"}], "tools": []})

    async with make_client(handler) as c:
        result = await c.prompts.render("greeting", "production", {"name": "Alice"})

    assert result.messages[0]["content"] == "Hi Alice"
    assert result.tools == []
    assert seen["auth"] == "Bearer test-key"
    assert seen["path"] == "/api/v1/prompts/greeting/production/render"
    assert seen["body"] == {"variables": {"name": "Alice"}}


async def test_render_prompt_returns_bound_model():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"messages": [{"role": "system", "content": "x"}], "model": "gpt-4o-mini"})

    async with make_client(handler) as c:
        result = await c.prompts.render("bound", "production")
    assert result.model == "gpt-4o-mini"


async def test_render_prompt_model_none_when_absent():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"messages": []})

    async with make_client(handler) as c:
        result = await c.prompts.render("nomodel", "production")
    assert result.model is None


async def test_render_prompt_caches_second_call():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"messages": [{"role": "system", "content": "x"}]})

    async with make_client(handler) as c:
        await c.prompts.render("p", "production", {"name": "Alice"})
        await c.prompts.render("p", "production", {"name": "Alice"})  # fresh hit — no 2nd call

    assert calls["n"] == 1


async def test_render_prompt_different_variables_are_rendered_again():
    def handler(request: httpx.Request) -> httpx.Response:
        name = body_of(request)["variables"]["name"]
        return httpx.Response(200, json={"messages": [{"role": "user", "content": f"Hello {name}"}]})

    async with make_client(handler) as c:
        alice = await c.prompts.render("p", "production", {"name": "Alice"})
        bob = await c.prompts.render("p", "production", {"name": "Bob"})

    assert alice.messages[0]["content"] == "Hello Alice"
    assert bob.messages[0]["content"] == "Hello Bob"


async def test_render_prompt_cache_key_ignores_variable_order():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"messages": [{"role": "system", "content": "x"}]})

    async with make_client(handler) as c:
        await c.prompts.render("p", "production", {"name": "Alice", "city": "Lahore"})
        await c.prompts.render("p", "production", {"city": "Lahore", "name": "Alice"})

    assert calls["n"] == 1


async def test_render_prompt_cache_ttl_zero_disables_the_cache():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"messages": [{"role": "system", "content": f"v{calls['n']}"}]})

    async with make_client(handler, cache_ttl=0) as c:
        first = await c.prompts.render("p", "production")
        second = await c.prompts.render("p", "production")

    assert first.messages[0]["content"] == "v1"
    assert second.messages[0]["content"] == "v2"
    assert calls["n"] == 2


async def test_render_prompt_cache_ttl_zero_stores_nothing():
    from acruxcore.cache import get_cache

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"messages": [{"role": "system", "content": "x"}]})

    async with make_client(handler, cache_ttl=0) as c:
        await c.prompts.render("p", "production")

    assert list(get_cache(500)._store.keys()) == []


async def test_render_prompt_stale_while_revalidate():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"messages": [{"role": "system", "content": f"v{calls['n']}"}]})

    # cache_ttl=1ms → the entry is stale by the time of the second call
    async with make_client(handler, cache_ttl=1) as c:
        r1 = await c.prompts.render("p", "production")
        assert r1.messages[0]["content"] == "v1"
        await asyncio.sleep(0.01)
        r2 = await c.prompts.render("p", "production")  # stale → serves v1, refreshes in bg
        assert r2.messages[0]["content"] == "v1"
        await asyncio.sleep(0.05)  # let the background refresh finish
        r3 = await c.prompts.render("p", "production")
        assert r3.messages[0]["content"] == "v2"

    assert calls["n"] == 2


async def test_render_prompt_missing_variables():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": "MISSING_VARIABLES", "message": "missing", "missing": ["name"]}})

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.prompts.render("p", "production")
    assert ei.value.code == "MISSING_VARIABLES"
    assert ei.value.status_code == 400
    assert ei.value.body["error"]["missing"] == ["name"]


async def test_render_prompt_returns_version_lineage():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "messages": [{"role": "user", "content": "Hello"}],
                "versionId": "v-123",
                "versionNumber": 4,
            },
        )

    async with make_client(handler) as c:
        result = await c.prompts.render("greeting", "production", {})
    assert result.version_id == "v-123"
    assert result.version_number == 4


async def test_render_prompt_version_lineage_defaults_to_none():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"messages": [{"role": "user", "content": "Hello"}]})

    async with make_client(handler) as c:
        result = await c.prompts.render("greeting", "production", {})
    assert result.version_id is None
    assert result.version_number is None


async def test_render_prompt_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.prompts.render("nope", "production")
    assert ei.value.code == "API_ERROR"
    assert ei.value.status_code == 404


# --- retry -----------------------------------------------------------------


async def test_retry_on_5xx_then_success():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, json={"error": {"code": "OOPS"}})
        return httpx.Response(200, json={"messages": []})

    async with make_client(handler, max_retries=1) as c:
        result = await c.prompts.render("p", "production")
    assert result.messages == []
    assert calls["n"] == 2  # retried once


async def test_no_retry_on_4xx():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"error": {"code": "BAD"}})

    async with make_client(handler, max_retries=3) as c:
        with pytest.raises(AcruxCoreError):
            await c.prompts.render("p", "production")
    assert calls["n"] == 1  # never retried


async def test_network_error_maps_to_network_error_code():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    async with make_client(handler, max_retries=0) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.prompts.render("p", "production")
    assert ei.value.code == "NETWORK_ERROR"


async def test_request_with_retry_retries_on_429():
    from acruxcore.http import request_with_retry

    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429)
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        res = await request_with_retry(client, "GET", "http://x/", max_retries=1, retry_interval_ms=1)
    assert res.status_code == 200
    assert calls["n"] == 2


async def test_request_with_retry_returns_last_429_after_exhausting_retries():
    from acruxcore.http import request_with_retry

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(429))) as client:
        res = await request_with_retry(client, "GET", "http://x/", max_retries=1, retry_interval_ms=1)
    assert res.status_code == 429


# --- chat ------------------------------------------------------------------


async def test_chat_non_streaming_and_gateway_meta():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/gateway/chat/completions"
        assert body_of(request)["model"] == "gpt-4o-mini"
        return httpx.Response(
            200,
            headers={
                "x-gateway-request-id": "req_1",
                "x-gateway-provider": "openrouter",
                "x-gateway-model": "gpt-4o-mini",
                "x-gateway-cost-usd": "0.0001",
                "x-gateway-cache": "miss",
                "x-gateway-trace-id": "trace_1",
                "x-gateway-span-id": "span_1",
            },
            json={
                "id": "chatcmpl-1",
                "model": "gpt-4o-mini",
                "choices": [{"message": {"role": "assistant", "content": "Hello!"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
            },
        )

    async with make_client(handler) as c:
        r = await c.gateway.chat("gpt-4o-mini", [{"role": "user", "content": "hi"}])

    assert r.content == "Hello!"
    assert r.finish_reason == "stop"
    assert r.usage.total_tokens == 7
    assert r.gateway.request_id == "req_1"
    assert r.gateway.provider == "openrouter"
    assert r.gateway.cost_usd == 0.0001
    assert r.gateway.trace_id == "trace_1"
    assert r.gateway.span_ref == "span_1"


async def test_chat_gateway_trace_opt_in_mints_a_fresh_span_id():
    """`chat(trace=True)` on the GATEWAY path must NOT re-post the gateway's own
    span id. The gateway has already persisted a span under that id and `spans` is
    unique on `(traceId, spanRef)`, so re-using it makes the ingest endpoint reject
    the insert — and the best-effort catch swallows the failure, recording nothing.
    The trace id IS still adopted, so the extra span joins the gateway's trace."""
    posted: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            return httpx.Response(
                200,
                headers={"x-gateway-trace-id": "gw-trace-1", "x-gateway-span-id": "gw-span-1"},
                json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]},
            )
        posted.append(body_of(request)["traces"][0])
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["gw-trace-1"]})

    async with make_client(handler) as c:
        await c.gateway.chat("m", [{"role": "user", "content": "hi"}], trace=True)

    assert len(posted) == 1
    span = posted[0]["spans"][0]
    assert posted[0]["traceId"] == "gw-trace-1"
    assert span["spanId"] != "gw-span-1"
    assert span["spanId"].startswith("chat-")


async def test_chat_byo_trace_reuses_the_locally_minted_span_id():
    """On the BYO path the span ref was minted by this very call and nothing is
    persisted under it, so it IS reused — keeping the id the caller reads off
    `result.gateway.span_ref` identical to the one actually reported."""
    posted: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]})
        posted.append(body_of(request)["traces"][0])
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    async with make_client(handler) as c:
        r = await c.gateway.chat(
            "m", [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "k"},
        )

    assert posted[0]["spans"][0]["spanId"] == r.gateway.span_ref
    assert posted[0]["traceId"] == r.gateway.trace_id


async def test_chat_body_snake_case_mapping():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(body_of(request))
        return httpx.Response(200, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

    async with make_client(handler) as c:
        await c.gateway.chat(
            "m",
            [{"role": "user", "content": "x"}],
            tool_refs=[{"name": "t", "alias": "production"}],
            tool_choice="auto",
            max_tokens=64,
            temperature=0.2,
        )

    assert seen["tool_refs"] == [{"name": "t", "alias": "production"}]
    assert seen["tool_choice"] == "auto"
    assert seen["max_tokens"] == 64
    assert seen["temperature"] == 0.2


async def test_chat_sends_response_format():
    seen: Dict[str, Any] = {}
    schema = {"type": "json_schema", "json_schema": {"name": "ok", "schema": {"type": "object"}, "strict": True}}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(body_of(request))
        return httpx.Response(200, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": '{"ok":true}'}, "finish_reason": "stop"}]})

    async with make_client(handler) as c:
        await c.gateway.chat("m", [{"role": "user", "content": "x"}], response_format=schema)

    assert seen["response_format"] == schema
    assert "tools" not in seen


async def test_chat_streaming():
    sse = (
        b'data: {"id":"1","model":"m","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        b'data: {"id":"1","model":"m","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
        b'data: {"id":"1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'
        b"data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert body_of(request)["stream"] is True
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)

    text = ""
    finish = None
    async with make_client(handler) as c:
        async for chunk in await c.gateway.stream("m", [{"role": "user", "content": "hi"}]):
            text += chunk.delta.get("content", "")
            if chunk.finish_reason:
                finish = chunk.finish_reason

    assert text == "Hello"
    assert finish == "stop"


async def test_chat_streaming_retries_on_429():
    """The gateway streaming path has its own inline retry loop (it cannot go
    through `request_with_retry`, which buffers). It must retry a 429 like a 5xx,
    the same as every other caller and as `_stream_via_provider` already did."""
    attempts = {"n": 0}
    sse = b'data: {"id":"1","model":"m","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] == 1:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)

    text = ""
    async with make_client(handler) as c:
        async for chunk in await c.gateway.stream("m", [{"role": "user", "content": "hi"}]):
            text += chunk.delta.get("content", "")

    assert attempts["n"] == 2
    assert text == "ok"


# --- BYO (provider-direct) completion ---------------------------------------


async def test_chat_byo_calls_provider_directly_not_gateway():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.groq.com/openai/v1/chat/completions"
        assert request.headers.get("authorization") == "Bearer groq-secret-key"
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-byo-1", "model": "llama-3.1-70b",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi!"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
            },
        )

    async with make_client(handler) as c:
        result = await c.gateway.chat(
            "llama-3.1-70b",
            [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "groq-secret-key"},
            trace=False,
        )
    assert result.content == "Hi!"
    assert result.finish_reason == "stop"
    assert result.usage.total_tokens == 7


async def test_chat_byo_gateway_meta_inferred_provider_null_cost_minted_ids():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-byo-2", "model": "gpt-4o-mini",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    async with make_client(handler) as c:
        result = await c.gateway.chat(
            "gpt-4o-mini",
            [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.openai.com/v1", "api_key": "sk-real"},
            trace=False,
        )
    assert result.gateway.request_id == "chatcmpl-byo-2"
    # infer_provider_name returns the raw hostname (project ruling, Task 4/5) —
    # not a shortened "openai".
    assert result.gateway.provider == "api.openai.com"
    assert result.gateway.cost_usd is None
    assert result.gateway.cache is None
    assert isinstance(result.gateway.trace_id, str)
    assert isinstance(result.gateway.span_ref, str)


async def test_chat_byo_client_level_default_used_when_no_per_call_provider():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.groq.com/openai/v1/chat/completions"
        return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

    transport = httpx.MockTransport(handler)
    async with AcruxCore(
        api_key="our-key", base_url="http://localhost:3000/api/v1", transport=transport,
        provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "groq-key"},
    ) as c:
        await c.gateway.chat("m", [{"role": "user", "content": "hi"}], trace=False)


async def test_chat_byo_per_call_provider_overrides_client_default():
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.together.xyz/v1/chat/completions"
        return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

    transport = httpx.MockTransport(handler)
    async with AcruxCore(
        api_key="our-key", base_url="http://localhost:3000/api/v1", transport=transport,
        provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "groq-key"},
    ) as c:
        await c.gateway.chat(
            "m", [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.together.xyz/v1", "api_key": "together-key"},
            trace=False,
        )


async def test_chat_byo_raises_provider_error_on_non_2xx():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid_api_key"}})

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.gateway.chat(
                "m", [{"role": "user", "content": "hi"}],
                provider={"base_url": "https://api.openai.com/v1", "api_key": "bad-key"},
                trace=False,
            )
    assert ei.value.code == "PROVIDER_ERROR"


async def test_chat_byo_auto_traces_with_one_llm_span():
    call_log = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(str(request.url))
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(
                200,
                json={
                    "id": "c1", "model": "m",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi there"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
                },
            )
        assert body_of(request)["traces"][0]["spans"][0]["kind"] == "llm"
        assert body_of(request)["traces"][0]["spans"][0]["model"] == "m"
        # infer_provider_name returns the raw hostname (project ruling, Task 4/5) —
        # not a shortened "openai".
        assert body_of(request)["traces"][0]["spans"][0]["provider"] == "api.openai.com"
        assert body_of(request)["traces"][0]["spans"][0]["promptVersionId"] == "v-42"
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["minted-trace"]})

    async with make_client(handler) as c:
        await c.gateway.chat(
            "m", [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.openai.com/v1", "api_key": "sk-x"},
            prompt_version_id="v-42",
        )
    assert len(call_log) == 2


async def test_chat_byo_skips_trace_when_trace_false():
    call_log = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(str(request.url))
        return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]})

    async with make_client(handler) as c:
        await c.gateway.chat(
            "m", [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.openai.com/v1", "api_key": "sk-x"},
            trace=False,
        )
    assert len(call_log) == 1


async def test_chat_byo_raises_missing_api_key_before_network_call():
    call_log = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(str(request.url))
        return httpx.Response(200, json={})

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.gateway.chat(
                "m", [{"role": "user", "content": "hi"}],
                provider={"base_url": "https://api.openai.com/v1", "api_key": ""},
            )
    assert ei.value.code == "MISSING_API_KEY"
    assert call_log == []


async def test_chat_byo_raises_missing_base_url_before_network_call():
    call_log = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(str(request.url))
        return httpx.Response(200, json={})

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.gateway.chat(
                "m", [{"role": "user", "content": "hi"}],
                provider={"base_url": "", "api_key": "k"},
            )
    assert ei.value.code == "MISSING_BASE_URL"
    assert call_log == []


async def test_chat_byo_streaming_raises_missing_api_key_before_network_call():
    call_log = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(str(request.url))
        return httpx.Response(200, json={})

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            stream = await c.gateway.stream(
                "m", [{"role": "user", "content": "hi"}],
                provider={"base_url": "https://api.openai.com/v1", "api_key": ""},
            )
            # Actually iterate the generator to trigger the validation
            async for _ in stream:
                pass
    assert ei.value.code == "MISSING_API_KEY"
    assert call_log == []


async def test_chat_byo_streaming_raises_missing_base_url_before_network_call():
    call_log = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(str(request.url))
        return httpx.Response(200, json={})

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            stream = await c.gateway.stream(
                "m", [{"role": "user", "content": "hi"}],
                provider={"base_url": "", "api_key": "k"},
            )
            # Actually iterate the generator to trigger the validation
            async for _ in stream:
                pass
    assert ei.value.code == "MISSING_BASE_URL"
    assert call_log == []


# --- BYO (provider-direct) streaming ----------------------------------------


async def test_chat_byo_streaming_sends_include_usage_and_auto_traces():
    sse = (
        b'data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        b'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
        b'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n'
        b'data: {"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n'
        b"data: [DONE]\n\n"
    )
    seen_trace_body = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            assert body_of(request)["stream_options"] == {"include_usage": True}
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)
        seen_trace_body.update(body_of(request))
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    text = ""
    async with make_client(handler) as c:
        stream = await c.gateway.stream(
            "m", [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "k"},
        )
        async for chunk in stream:
            text += chunk.delta.get("content", "")

    assert text == "Hello"
    # Exiting the `async with` above closed the client, which flushes the span queue —
    # so the backgrounded post-stream report has definitely landed by here.
    span = seen_trace_body["traces"][0]["spans"][0]
    assert span["kind"] == "llm"
    assert span["output"] == {"role": "assistant", "content": "Hello"}
    assert span["usage"] == {"promptTokens": 4, "completionTokens": 2, "totalTokens": 6}
    # A streamed turn has no single response object, so `finish_reason` would otherwise
    # be lost entirely — it is the only record of WHY the stream ended.
    assert span["attributes"] == {"finishReason": "stop"}


async def test_chat_byo_streaming_accumulates_tool_call_fragments_into_trace():
    # The tool call's id/name arrive on the first frame; its arguments are
    # fragmented across subsequent frames, correlated by the wire `index`.
    sse = (
        b'data: {"id":"c1","model":"m","choices":[{"delta":{"role":"assistant","tool_calls":'
        b'[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},'
        b'"finish_reason":null}]}\n\n'
        b'data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":'
        b'[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n'
        b'data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":'
        b'[{"index":0,"function":{"arguments":"\\"Berlin\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        b'data: {"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n'
        b"data: [DONE]\n\n"
    )
    seen_trace_body: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)
        seen_trace_body.update(body_of(request))
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    async with make_client(handler) as c:
        stream = await c.gateway.stream(
            "m", [{"role": "user", "content": "weather in Berlin?"}],
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "k"},
        )
        async for _ in stream:
            pass

    # Exiting the `async with` above closed the client, which flushes the span queue —
    # so the backgrounded post-stream report has definitely landed by here.
    span = seen_trace_body["traces"][0]["spans"][0]
    tool_calls = span["output"]["tool_calls"]
    assert len(tool_calls) == 1
    assert tool_calls[0]["id"] == "call_1"
    assert tool_calls[0]["function"]["name"] == "get_weather"
    assert tool_calls[0]["function"]["arguments"] == '{"city":"Berlin"}'


async def test_chat_byo_streaming_does_not_replay_the_completion_after_a_mid_stream_drop():
    """Regression guard: the retry loop wraps stream *consumption*, so a transport error
    landing after chunks had already been yielded used to restart the whole request —
    the caller saw the truncated first response followed by a second, complete one, and
    the reported span recorded both concatenated. Retries now stop once the first chunk
    has been delivered (`max_retries` defaults to 1, so without the guard this replays)."""
    completions_calls = 0

    async def dropped_mid_stream() -> Any:
        yield b'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
        raise httpx.ReadError("connection dropped mid-stream")

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal completions_calls
        if request.url.path.endswith("/chat/completions"):
            completions_calls += 1
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=dropped_mid_stream(),
            )
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    received = ""
    async with make_client(handler) as c:
        stream = await c.gateway.stream(
            "m", [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "k"},
        )
        with pytest.raises(AcruxCoreError) as excinfo:
            async for chunk in stream:
                received += chunk.delta.get("content", "")

    assert excinfo.value.code == "NETWORK_ERROR"
    # The partial response stays partial rather than having a second one replayed onto it.
    assert received == "Hel"
    assert completions_calls == 1


async def test_chat_threads_trace_id_across_two_manual_calls():
    completions = 0
    trace_bodies: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal completions
        if request.url.path.endswith("/chat/completions"):
            completions += 1
            content = "first" if completions == 1 else "second"
            return httpx.Response(200, json={"id": f"c{completions}", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]})
        trace_bodies.append(body_of(request))
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    async with make_client(handler) as c:
        first = await c.gateway.chat("m", [{"role": "user", "content": "a"}], provider={"base_url": "https://api.openai.com/v1", "api_key": "k"})
        await c.gateway.chat(
            "m", [{"role": "user", "content": "b"}],
            provider={"base_url": "https://api.openai.com/v1", "api_key": "k"},
            trace={"trace_id": first.gateway.trace_id},
        )
        # Auto-reports are backgrounded now, so wait for the queue before reading the
        # requests it made.
        await c.gateway.flush()

    # The first call auto-traces (BYO default) and mints its own trace id; the
    # second call's explicit trace={"trace_id": ...} must thread that same id through
    # rather than minting a fresh one. How many requests carried the two spans is
    # emergent — the queue coalesces whatever piles up behind a request in flight — so
    # assert over the entries, not over the request count.
    entries = [t for b in trace_bodies for t in b["traces"]]
    spans = [s for t in entries for s in t["spans"]]
    assert len(spans) == 2
    assert {t["traceId"] for t in entries} == {first.gateway.trace_id}


# --- run_tool_loop ---------------------------------------------------------


def _tool_call(call_id: str, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


async def test_run_tool_loop_threads_trace_and_reports_tool_spans():
    """First round returns tool_calls; second returns a final answer. Verifies the
    gateway's trace id is adopted, threaded via x-trace-id on round 2, and one
    POST /traces carries the tool span parented to the llm span."""
    state = {"round": 0}
    captured: Dict[str, Any] = {"headers": [], "trace_body": None}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            state["round"] += 1
            captured["headers"].append(dict(request.headers))
            common = {"x-gateway-trace-id": "trace_abc", "x-gateway-span-id": f"llm-span-{state['round']}"}
            if state["round"] == 1:
                return httpx.Response(
                    200,
                    headers=common,
                    json={"id": "c1", "model": "m", "choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("call_1", "get_weather", {"city": "Tokyo"})]}, "finish_reason": "tool_calls"}]},
                )
            return httpx.Response(
                200,
                headers=common,
                json={"id": "c2", "model": "m", "choices": [{"message": {"role": "assistant", "content": "It is 18C in Tokyo."}, "finish_reason": "stop"}]},
            )
        if request.url.path.endswith("/traces"):
            captured["trace_body"] = body_of(request)
            return httpx.Response(200, json={"accepted": 1, "traceIds": ["trace_abc"]})
        raise AssertionError(f"unexpected path {request.url.path}")

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:
        assert name == "get_weather"
        assert args == {"city": "Tokyo"}
        return {"tempC": 18, "condition": "clear"}

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop(
            "m",
            [{"role": "user", "content": "weather in Tokyo?"}],
            dispatch=dispatch,
            tool_defs=[{"type": "function", "function": {"name": "get_weather"}}],
        )

    assert result.content == "It is 18C in Tokyo."
    assert result.iterations == 2
    assert result.stopped_at_limit is False
    assert result.trace_id == "trace_abc"

    # Round 1 sends x-trace-name but no x-trace-id yet; round 2 threads x-trace-id.
    assert "x-trace-id" not in captured["headers"][0]
    assert captured["headers"][1]["x-trace-id"] == "trace_abc"

    # Exactly one tool span, parented to round-1's llm span, carrying payloads.
    body = captured["trace_body"]
    assert body["traces"][0]["traceId"] == "trace_abc"
    spans = body["traces"][0]["spans"]
    assert len(spans) == 1
    assert spans[0]["name"] == "get_weather"
    assert spans[0]["kind"] == "tool"
    assert spans[0]["parentSpanId"] == "llm-span-1"
    assert spans[0]["output"] == {"tempC": 18, "condition": "clear"}


async def test_run_tool_loop_threads_session_id_header():
    """When a session_id is given, every gateway call carries x-session-id so the
    gateway stamps the session when it creates the trace."""
    captured: Dict[str, Any] = {"headers": []}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            captured["headers"].append(dict(request.headers))
            return httpx.Response(
                200,
                headers={"x-gateway-trace-id": "trace_abc"},
                json={"id": "c", "model": "m", "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]},
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:  # pragma: no cover
        raise AssertionError("no tool should be dispatched")

    async with make_client(handler) as c:
        await c.gateway.run_tool_loop(
            "m",
            [{"role": "user", "content": "hi"}],
            dispatch=dispatch,
            trace={"name": "run", "session_id": "sess-1"},
        )

    assert captured["headers"][0]["x-session-id"] == "sess-1"


async def test_run_tool_loop_concurrent_dispatch_order_preserved():
    order_started: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            if not order_started:  # first call → ask for two tools at once
                return httpx.Response(
                    200,
                    headers={"x-gateway-trace-id": "t", "x-gateway-span-id": "s"},
                    json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("a", "slow", {}), _tool_call("b", "fast", {})]}, "finish_reason": "tool_calls"}]},
                )
            return httpx.Response(200, headers={"x-gateway-trace-id": "t", "x-gateway-span-id": "s2"}, json={"id": "2", "model": "m", "choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]})
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t"]})

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:
        order_started.append(name)
        # "slow" sleeps longer, but results must still be appended in call order.
        await asyncio.sleep(0.02 if name == "slow" else 0.0)
        return f"{name}-result"

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop("m", [{"role": "user", "content": "go"}], dispatch=dispatch, tool_defs=[])

    # Both tools were dispatched concurrently (fast started before slow finished).
    assert set(order_started) == {"slow", "fast"}
    # Tool result messages appended in call order: slow (call a) then fast (call b).
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    assert tool_msgs[0]["tool_call_id"] == "a"
    assert tool_msgs[1]["tool_call_id"] == "b"
    assert result.content == "done"


async def test_run_tool_loop_dispatch_error_propagates():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            return httpx.Response(200, headers={"x-gateway-trace-id": "t", "x-gateway-span-id": "s"}, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("a", "boom", {})]}, "finish_reason": "tool_calls"}]})
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t"]})

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:
        raise ValueError("tool exploded")

    async with make_client(handler) as c:
        with pytest.raises(ValueError, match="tool exploded"):
            await c.gateway.run_tool_loop("m", [{"role": "user", "content": "go"}], dispatch=dispatch, tool_defs=[])


async def test_run_tool_loop_stops_at_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            return httpx.Response(200, headers={"x-gateway-trace-id": "t", "x-gateway-span-id": "s"}, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("a", "loop", {})]}, "finish_reason": "tool_calls"}]})
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t"]})

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:
        return "again"

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop("m", [{"role": "user", "content": "go"}], dispatch=dispatch, tool_defs=[], max_iterations=3)

    assert result.stopped_at_limit is True
    assert result.iterations == 3


async def test_run_tool_loop_threads_response_format_when_no_tools_attached():
    """response_format and tools are mutually exclusive on the gateway, so this
    exercises the valid shape: a tool-less loop shaping a typed final answer."""
    seen: Dict[str, Any] = {}
    schema = {"type": "json_schema", "json_schema": {"name": "final_answer", "schema": {"type": "object"}, "strict": True}}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            seen.update(body_of(request))
            return httpx.Response(200, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": '{"answer":"ok"}'}, "finish_reason": "stop"}]})
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t"]})

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop("m", [{"role": "user", "content": "summarize"}], response_format=schema, trace=False)

    assert result.content == '{"answer":"ok"}'
    assert seen["response_format"] == schema
    assert "tools" not in seen
    assert "tool_refs" not in seen


async def test_run_tool_loop_shapes_typed_answer_when_tools_and_response_format_given():
    """Tools + response_format can't share one gateway request, so the SDK gathers (tools,
    no format) then shapes (format, no tools) on the same trace. Gather rounds carry tools
    and no response_format; only the shaping round carries response_format."""
    schema = {"type": "json_schema", "json_schema": {"name": "weather", "schema": {"type": "object"}, "strict": True}}
    state = {"round": 0}
    completion_bodies: List[Dict[str, Any]] = []
    completion_headers: List[Dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            state["round"] += 1
            completion_bodies.append(body_of(request))
            completion_headers.append(dict(request.headers))
            common = {"x-gateway-trace-id": "trace_abc", "x-gateway-span-id": f"llm-span-{state['round']}"}
            if state["round"] == 1:
                return httpx.Response(200, headers=common, json={"id": "c1", "model": "m", "choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("call_1", "get_weather", {"city": "Tokyo"})]}, "finish_reason": "tool_calls"}]})
            if state["round"] == 2:
                return httpx.Response(200, headers=common, json={"id": "c2", "model": "m", "choices": [{"message": {"role": "assistant", "content": "It is 18C in Tokyo."}, "finish_reason": "stop"}]})
            return httpx.Response(200, headers=common, json={"id": "c3", "model": "m", "choices": [{"message": {"role": "assistant", "content": '{"tempC":18,"city":"Tokyo"}'}, "finish_reason": "stop"}]})
        if request.url.path.endswith("/traces"):
            return httpx.Response(200, json={"accepted": 1, "traceIds": ["trace_abc"]})
        raise AssertionError(f"unexpected path {request.url.path}")

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:
        return {"tempC": 18}

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop(
            "m",
            [{"role": "user", "content": "weather in Tokyo?"}],
            dispatch=dispatch,
            tool_defs=[{"type": "function", "function": {"name": "get_weather"}}],
            response_format=schema,
        )

    # Three completion calls (2 gather + 1 shape); the shaped JSON is the result content.
    assert len(completion_bodies) == 3
    assert result.content == '{"tempC":18,"city":"Tokyo"}'
    assert result.iterations == 2
    assert result.trace_id == "trace_abc"
    # Gather rounds carry tools and NO response_format.
    for b in completion_bodies[:2]:
        assert "tools" in b
        assert "response_format" not in b
    # The shaping round carries response_format and NO tools / tool_refs.
    assert completion_bodies[2]["response_format"] == schema
    assert "tools" not in completion_bodies[2]
    assert "tool_refs" not in completion_bodies[2]
    # Phase 2 reuses phase 1's trace (seeded via the trace dict).
    assert completion_headers[2]["x-trace-id"] == "trace_abc"


# --- pydantic-built response_format -------------------------------------------
# These mirror the three dict-path tests above, but build the format from a pydantic
# BaseModel via acruxcore.pydantic_response_format(). The SDK converts the class to the
# same OpenAI-shaped wire dict at send time, so the assertions check the *converted* dict
# equals what model_json_schema() produces, wrapped in {type: json_schema, json_schema: {...}}.

class _WeatherAnswer(pydantic.BaseModel):
    """Mirrors the shape the dict-path tests use, so the two paths are directly comparable."""
    temp_c: int = pydantic.Field(description="Temperature in Celsius")
    city: str = pydantic.Field(description="City name")


@pydantic_required
async def test_chat_converts_pydantic_response_format():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(body_of(request))
        return httpx.Response(200, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": '{"temp_c":18}'}, "finish_reason": "stop"}]})

    async with make_client(handler) as c:
        await c.gateway.chat("m", [{"role": "user", "content": "x"}],
                     response_format=pydantic_response_format(_WeatherAnswer, name="weather_answer"))

    # The wire body carries the converted OpenAI-shaped dict, not the pydantic class.
    # strict=True (default) runs the OpenAI strict normalizer: titles stripped, every
    # object gets additionalProperties:false.
    expected_schema = _strict_for_openai(_WeatherAnswer.model_json_schema())
    assert seen["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "weather_answer", "schema": expected_schema, "strict": True},
    }
    # The normalizer did its job: no title keys, and additionalProperties:false on the root.
    assert "title" not in seen["response_format"]["json_schema"]["schema"]
    assert seen["response_format"]["json_schema"]["schema"]["additionalProperties"] is False
    assert "tools" not in seen


@pydantic_required
async def test_run_tool_loop_threads_pydantic_response_format_when_no_tools_attached():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            seen.update(body_of(request))
            return httpx.Response(200, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": '{"temp_c":18}'}, "finish_reason": "stop"}]})
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t"]})

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop(
            "m", [{"role": "user", "content": "summarize"}],
            response_format=pydantic_response_format(_WeatherAnswer, name="weather_answer", strict=False),
            trace=False,
        )

    assert result.content == '{"temp_c":18}'
    expected_schema = _WeatherAnswer.model_json_schema()
    assert seen["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "weather_answer", "schema": expected_schema, "strict": False},
    }
    assert "tools" not in seen
    assert "tool_refs" not in seen


@pydantic_required
async def test_run_tool_loop_shapes_typed_answer_with_pydantic_response_format():
    """Same two-phase split as the dict test, but the format is built from a pydantic class.
    Gather rounds carry tools and no response_format; only the shaping round carries the
    converted response_format dict."""
    state = {"round": 0}
    completion_bodies: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            state["round"] += 1
            completion_bodies.append(body_of(request))
            common = {"x-gateway-trace-id": "trace_abc", "x-gateway-span-id": f"llm-span-{state['round']}"}
            if state["round"] == 1:
                return httpx.Response(200, headers=common, json={"id": "c1", "model": "m", "choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("call_1", "get_weather", {"city": "Tokyo"})]}, "finish_reason": "tool_calls"}]})
            if state["round"] == 2:
                return httpx.Response(200, headers=common, json={"id": "c2", "model": "m", "choices": [{"message": {"role": "assistant", "content": "It is 18C in Tokyo."}, "finish_reason": "stop"}]})
            return httpx.Response(200, headers=common, json={"id": "c3", "model": "m", "choices": [{"message": {"role": "assistant", "content": '{"temp_c":18,"city":"Tokyo"}'}, "finish_reason": "stop"}]})
        if request.url.path.endswith("/traces"):
            return httpx.Response(200, json={"accepted": 1, "traceIds": ["trace_abc"]})
        raise AssertionError(f"unexpected path {request.url.path}")

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:
        return {"tempC": 18}

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop(
            "m",
            [{"role": "user", "content": "weather in Tokyo?"}],
            dispatch=dispatch,
            tool_defs=[{"type": "function", "function": {"name": "get_weather"}}],
            response_format=pydantic_response_format(_WeatherAnswer, name="weather_answer"),
        )

    assert len(completion_bodies) == 3
    assert result.content == '{"temp_c":18,"city":"Tokyo"}'
    assert result.iterations == 2
    # Gather rounds carry tools and NO response_format.
    for b in completion_bodies[:2]:
        assert "tools" in b
        assert "response_format" not in b
    # The shaping round carries the CONVERTED response_format dict (strict-normalized) and
    # no tools.
    expected_schema = _strict_for_openai(_WeatherAnswer.model_json_schema())
    assert completion_bodies[2]["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "weather_answer", "schema": expected_schema, "strict": True},
    }
    assert "tools" not in completion_bodies[2]
    assert "tool_refs" not in completion_bodies[2]


async def test_run_tool_loop_trace_false_sends_no_headers_no_traces():
    trace_posted = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            assert "x-trace-name" not in request.headers
            return httpx.Response(200, json={"id": "1", "model": "m", "choices": [{"message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]})
        trace_posted["n"] += 1
        return httpx.Response(200, json={"accepted": 0, "traceIds": []})

    async def dispatch(name: str, args: Dict[str, Any]) -> Any:
        return "x"

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop("m", [{"role": "user", "content": "go"}], dispatch=dispatch, trace=False)

    assert result.trace_id is None
    assert trace_posted["n"] == 0


async def test_run_tool_loop_byo_calls_provider_directly_and_reports_llm_plus_tool_spans():
    """A provider= (BYO) run_tool_loop call must hit the provider's base_url directly
    on every round — never the gateway — and still mint a trace id across both
    rounds since there is no gateway trace to adopt."""
    call_log: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        call_log.append(str(request.url))
        if request.url.path.endswith("/chat/completions"):
            if len(call_log) == 1:
                return httpx.Response(200, json={
                    "id": "c1", "model": "m",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("t1", "get_weather", {"city": "Paris"})]}, "finish_reason": "tool_calls"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                })
            return httpx.Response(200, json={
                "id": "c2", "model": "m",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "It is 18C in Paris."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
            })
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["minted-trace"]})

    async with make_client(handler) as c:
        result = await c.gateway.run_tool_loop(
            "m", [{"role": "user", "content": "weather in Paris?"}],
            tool_defs=[{"type": "function", "function": {"name": "get_weather"}}],
            dispatch=lambda name, args: {"tempC": 18},
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "groq-key"},
        )
    assert result.content == "It is 18C in Paris."
    completions = [url for url in call_log if url.endswith("/chat/completions")]
    assert completions == ["https://api.groq.com/openai/v1/chat/completions"] * 2
    # Each round's llm span is handed to the background queue as soon as that round
    # returns, so a /traces call lands between or just after the completions. Which is
    # deliberately NOT asserted as a fixed position: the drain is a task, so exactly
    # where its request falls between two awaits is scheduling, not behaviour. The
    # ordering that IS a correctness requirement — the llm span reaching the platform
    # before a server-side tool dispatches — has its own test below
    # (test_run_tool_loop_byo_reports_llm_span_before_dispatching_an_http_tool).
    assert any(url.endswith("/api/v1/traces") for url in call_log)
    assert result.trace_id  # one trace minted across both rounds


async def test_run_tool_loop_byo_inlines_tool_schema_not_tool_refs():
    """On the BYO path there is no server-side catalog to resolve tool_refs against,
    so every tool (declared, ref-resolved, or raw tool_defs) must be sent as a full
    inlined JSON-Schema `tools` entry instead of `tool_refs`."""
    seen_bodies: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [{
                "toolId": "tool-1", "versionNumber": 1, "executorType": "client",
                "function": {"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}},
            }]})
        if request.url.path.endswith("/chat/completions"):
            seen_bodies.append(body_of(request))
            return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]})
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    async with make_client(handler) as c:
        await c.gateway.run_tool_loop(
            "m", [{"role": "user", "content": "weather?"}],
            tool_refs=[{"name": "get_weather"}],
            dispatch=lambda name, args: {},
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "k"},
        )
    assert "tool_refs" not in seen_bodies[0]
    assert seen_bodies[0]["tools"] == [{
        "type": "function",
        "function": {"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}},
    }]


async def test_run_tool_loop_byo_reports_llm_span_before_dispatching_an_http_tool():
    """A BYO round's `llm` span must reach POST /traces BEFORE that round's
    server-side (`http`) tool is executed.

    The platform's execute endpoint creates the trace itself when the supplied
    trace id does not exist yet — naming it `tool:<toolName>` and dropping the
    caller's parent span — so deferring the `llm` span to loop end left the tool
    span orphaned at the root of a mis-named trace. Ordering, not payload, is the
    whole fix, so ordering is what this asserts."""
    order: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/tools/resolve"):
            return httpx.Response(200, json={"data": [{
                "toolId": "tool-1", "versionNumber": 1, "executorType": "http",
                "function": {"name": "probe", "parameters": {"type": "object", "properties": {}}},
            }]})
        if path.endswith("/chat/completions"):
            order.append("completion")
            if order.count("completion") == 1:
                return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [_tool_call("t1", "probe", {})]}, "finish_reason": "tool_calls"}]})
            return httpx.Response(200, json={"id": "c2", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "200", "tool_calls": None}, "finish_reason": "stop"}]})
        if path.endswith("/execute"):
            order.append("execute")
            return httpx.Response(200, json={"result": {"status": 200}, "status": 200, "latencyMs": 1, "toolVersionId": "v1"})
        order.append("traces")
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["minted-trace"]})

    async with make_client(handler) as c:
        await c.gateway.run_tool_loop(
            "m", [{"role": "user", "content": "probe it"}],
            tool_refs=[{"name": "probe"}],
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "k"},
        )

    assert order[:3] == ["completion", "traces", "execute"]


async def test_run_tool_loop_byo_llm_span_times_the_completion_call():
    """The BYO `llm` span's `startTime` must be captured BEFORE the completion,
    otherwise the ingest endpoint (which derives latency from endTime−startTime)
    stores 0 ms for every round. The handler stalls, so a span timed only after
    the call returned cannot fake a non-zero duration."""
    stall_s = 0.05
    spans: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            time.sleep(stall_s)
            return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}]})
        spans.extend(body_of(request)["traces"][0]["spans"])
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    async with make_client(handler) as c:
        await c.gateway.run_tool_loop(
            "m", [{"role": "user", "content": "hi"}],
            provider={"base_url": "https://api.groq.com/openai/v1", "api_key": "k"},
        )

    llm_spans = [s for s in spans if s["kind"] == "llm"]
    assert len(llm_spans) == 1
    started = datetime.fromisoformat(llm_spans[0]["startTime"])
    ended = datetime.fromisoformat(llm_spans[0]["endTime"])
    assert (ended - started).total_seconds() >= stall_s


# --- trace / feedback / read-back ------------------------------------------


async def test_trace_write():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = body_of(request)
        return httpx.Response(200, json={"accepted": 2, "traceIds": ["trace_xyz"]})

    async with make_client(handler) as c:
        r = await c.traces.ingest({"name": "run", "spans": [{"spanId": "s1", "name": "step", "kind": "chain", "startTime": "2026-01-01T00:00:00Z"}]})

    assert r.trace_id == "trace_xyz"
    assert seen["body"]["traces"][0]["name"] == "run"


async def test_submit_feedback():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/v1/traces/trace_1/feedback"
        b = body_of(request)
        assert b == {"rating": 5, "source": "end_user"}
        return httpx.Response(201, json={"id": "fb_1", "traceId": "trace_1", "spanId": None, "rating": 5, "label": None, "comment": None, "source": "end_user", "createdBy": "u1", "createdAt": "t", "updatedAt": "t"})

    async with make_client(handler) as c:
        fb = await c.traces.submit_feedback("trace_1", rating=5, source="end_user")

    assert fb.id == "fb_1"
    assert fb.rating == 5
    assert fb.source == "end_user"


async def test_update_feedback_clear_vs_keep():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        b = body_of(request)
        # rating cleared (None), comment changed, label omitted entirely
        assert b == {"rating": None, "comment": "edited"}
        return httpx.Response(200, json={"id": "fb_1", "traceId": "trace_1", "spanId": None, "rating": None, "label": None, "comment": "edited", "source": "user", "createdBy": "u1", "createdAt": "t", "updatedAt": "t2"})

    async with make_client(handler) as c:
        fb = await c.traces.update_feedback("trace_1", "fb_1", rating=None, comment="edited")

    assert fb.comment == "edited"
    assert fb.rating is None


async def test_get_trace_builds_span_tree():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "trace": {"id": "t1", "name": "run", "sessionId": None, "status": "ok", "startedAt": "a", "endedAt": "b", "spanCount": 2, "totalCostUsd": 0.001, "totalTokens": 10},
            "spans": [{"spanId": "llm1", "parentSpanId": None, "kind": "llm", "name": "gpt", "status": "ok", "startedAt": "a", "endedAt": "b", "latencyMs": 100, "model": "gpt", "provider": "openrouter", "promptTokens": 5, "completionTokens": 5, "totalTokens": 10, "costUsd": 0.001, "promptVersionId": None, "gatewayRequestId": "r1", "errorMessage": None, "attributes": {}, "tags": [], "metadata": {}, "children": [{"spanId": "tool1", "parentSpanId": "llm1", "kind": "tool", "name": "get_weather", "status": "ok", "startedAt": "a", "endedAt": "b", "latencyMs": 5, "model": None, "provider": None, "promptTokens": None, "completionTokens": None, "totalTokens": None, "costUsd": None, "promptVersionId": None, "gatewayRequestId": None, "errorMessage": None, "attributes": {}, "tags": [], "metadata": {}, "children": []}]}],
        })

    async with make_client(handler) as c:
        r = await c.traces.get("t1")

    assert r.trace.id == "t1"
    assert r.trace.total_cost_usd == 0.001
    assert r.spans[0].span_id == "llm1"
    assert r.spans[0].children[0].name == "get_weather"
    assert r.spans[0].children[0].parent_span_id == "llm1"


async def test_list_traces_query_params():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["query"] = dict(request.url.params)
        return httpx.Response(200, json={"data": [{"id": "t1", "name": "n", "sessionId": "sess", "status": "ok", "startedAt": "a", "endedAt": "b", "spanCount": 1, "totalCostUsd": None, "totalTokens": None}], "total": 1, "page": 1, "limit": 10})

    async with make_client(handler) as c:
        r = await c.traces.list(session_id="sess", model="gpt", limit=10, min_tokens=3)

    assert seen["query"]["session_id"] == "sess"
    assert seen["query"]["model"] == "gpt"
    assert seen["query"]["limit"] == "10"
    assert seen["query"]["min_tokens"] == "3"
    assert r.total == 1
    assert r.data[0].id == "t1"


# --- Finding #20: SDK cache key must not embed the raw API key -------------


async def test_cache_key_does_not_embed_raw_api_key():
    from acruxcore.cache import get_cache

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"messages": [{"role": "system", "content": "hi"}]})

    raw_key = "sk-super-secret-raw-key"
    transport = httpx.MockTransport(handler)
    async with AcruxCore(api_key=raw_key, base_url="http://localhost:3000/api/v1", transport=transport) as c:
        await c.prompts.render("my-prompt", "production")

    keys = list(get_cache(500)._store.keys())
    assert len(keys) > 0
    for key in keys:
        assert raw_key not in key


# --- Finding #21: HTTPS enforcement warning on base_url ---------------------


def test_warns_for_plain_http_non_loopback_base_url(recwarn):
    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        AcruxCore(api_key="k", base_url="http://example.com", transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert len(caught) == 1
    assert "https" in str(caught[0].message).lower()


def test_no_warning_for_https_base_url():
    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        AcruxCore(api_key="k", base_url="https://example.com", transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert len(caught) == 0


def test_no_warning_for_localhost_base_url():
    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        AcruxCore(api_key="k", base_url="http://localhost:3000", transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert len(caught) == 0


async def test_warns_once_for_a_plain_http_provider_base_url():
    """The BYO path sends the caller's PROVIDER key as a Bearer token to a
    caller-supplied URL, so it needs the same cleartext check the platform
    `base_url` already had — but only once per URL, since it runs per call (and per
    round inside `run_tool_loop`)."""
    import warnings

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json={"id": "c1", "model": "m", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]})
        return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})

    provider = {"base_url": "http://provider.test.invalid/v1", "api_key": "k"}
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        async with make_client(handler) as c:
            await c.gateway.chat("m", [{"role": "user", "content": "hi"}], provider=provider, trace=False)
            await c.gateway.chat("m", [{"role": "user", "content": "hi"}], provider=provider, trace=False)

    cleartext = [w for w in caught if "not HTTPS" in str(w.message)]
    assert len(cleartext) == 1
    assert "provider.base_url" in str(cleartext[0].message)


def test_no_warning_for_loopback_provider_base_url():
    """The local-dev case (`http://localhost:11434` and friends) stays quiet."""
    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        AcruxCore(
            api_key="k",
            base_url="https://example.com",
            provider={"base_url": "http://localhost:11434/v1", "api_key": "k"},
            transport=httpx.MockTransport(lambda r: httpx.Response(200)),
        )
    assert len(caught) == 0


def test_no_warning_for_127_0_0_1_base_url():
    import warnings

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        AcruxCore(api_key="k", base_url="http://127.0.0.1:3000", transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert len(caught) == 0


# --- Finding #22: auth-header construction is not duplicated/drifted -------


async def test_auth_headers_consistent_across_render_trace_and_chat():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/render"):
            seen["render_auth"] = request.headers.get("authorization")
            seen["render_ct"] = request.headers.get("content-type")
            return httpx.Response(200, json={"messages": [{"role": "system", "content": "hi"}]})
        if path.endswith("/traces"):
            seen["trace_auth"] = request.headers.get("authorization")
            seen["trace_ct"] = request.headers.get("content-type")
            return httpx.Response(200, json={"accepted": 1, "traceIds": ["t1"]})
        if path.endswith("/chat/completions"):
            seen["chat_auth"] = request.headers.get("authorization")
            seen["chat_ct"] = request.headers.get("content-type")
            return httpx.Response(200, json={
                "id": "c1", "model": "m",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
            })
        raise AssertionError(f"unexpected path {path}")

    async with make_client(handler) as c:
        await c.prompts.render("p", "production")
        await c.traces.ingest({"spans": []})
        await c.gateway.chat(model="m", messages=[{"role": "user", "content": "hi"}])

    assert seen["render_auth"] == "Bearer test-key"
    assert seen["render_auth"] == seen["trace_auth"] == seen["chat_auth"]
    assert seen["render_ct"] == seen["trace_ct"] == seen["chat_ct"] == "application/json"


def test_auth_headers_helper_merges_extra_headers():
    c = AcruxCore(api_key="test-key", base_url="http://localhost:3000", transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert c._auth_headers() == {"Authorization": "Bearer test-key", "Content-Type": "application/json"}
    assert c._auth_headers({"x-trace-id": "abc"}) == {
        "Authorization": "Bearer test-key",
        "Content-Type": "application/json",
        "x-trace-id": "abc",
    }


# --- run_tool_loop: reconcile-and-route ------------------------------------


def tool_loop_handler(
    *,
    executor_type: str = "client",
    calls: Optional[List[str]] = None,
) -> Callable[[httpx.Request], httpx.Response]:
    """A transport that plays a full one-tool loop, recording the paths it served.

    First completion asks for get_weather; second returns prose. Sync and resolve
    answer with ``executor_type``, so one handler covers both routing branches.
    """
    seen = calls if calls is not None else []
    state = {"completions": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        seen.append(path)
        if path.endswith("/tools/sync"):
            return httpx.Response(
                200,
                json={
                    "toolId": "t-1",
                    "versionNumber": 1,
                    "committed": True,
                    "alias": "production",
                },
            )
        if path.endswith("/tools/resolve"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "toolId": "t-1",
                            "versionNumber": 1,
                            "executorType": executor_type,
                            "function": {
                                "name": "get_weather",
                                "description": "W.",
                                "parameters": {},
                            },
                        }
                    ]
                },
            )
        if path.endswith("/tools/t-1/execute"):
            return httpx.Response(
                200,
                json={
                    "result": {"temp_c": 30},
                    "status": 200,
                    "latencyMs": 12,
                    "toolVersionId": "v-1",
                },
            )
        if path.endswith("/traces"):
            return httpx.Response(201, json={"accepted": 1, "traceIds": ["tr-1"]})
        if path.endswith("/gateway/chat/completions"):
            state["completions"] += 1
            if state["completions"] == 1:
                return httpx.Response(
                    200,
                    headers={"x-gateway-trace-id": "tr-1", "x-gateway-span-id": "sp-1"},
                    json={
                        "id": "c1",
                        "model": "m",
                        "choices": [
                            {
                                "message": {
                                    "role": "assistant",
                                    "content": None,
                                    "tool_calls": [
                                        _tool_call("call-1", "get_weather", {"city": "Lahore"})
                                    ],
                                },
                                "finish_reason": "tool_calls",
                            }
                        ],
                    },
                )
            return httpx.Response(
                200,
                headers={"x-gateway-trace-id": "tr-1"},
                json={
                    "id": "c2",
                    "model": "m",
                    "choices": [
                        {
                            "message": {"role": "assistant", "content": "It is 30C."},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )
        return httpx.Response(404, json={})

    return handler


def _weather_tool(ran: Optional[List[str]] = None) -> Any:
    """A freshly decorated get_weather, so each test gets its own sync-cache identity."""
    from acruxcore import acrux
    from acruxcore.tools_api import _reset_sync_cache_for_testing

    _reset_sync_cache_for_testing()

    @acrux.tool
    async def get_weather(city: str) -> dict:
        """Get the current weather for a city.

        Args:
            city: City name.
        """
        if ran is not None:
            ran.append(city)
        return {"temp_c": 30}

    return get_weather


async def test_loop_with_a_decorated_tool_syncs_then_runs_it_locally():
    ran: List[str] = []
    get_weather = _weather_tool(ran)

    paths: List[str] = []
    async with make_client(tool_loop_handler(calls=paths)) as client:
        result = await client.gateway.run_tool_loop(
            model="m", messages=[{"role": "user", "content": "?"}], tools=[get_weather]
        )

    assert result.content == "It is 30C."
    assert ran == ["Lahore"]
    assert any(p.endswith("/tools/sync") for p in paths)
    # A decorated tool is client-side by definition — no resolve round-trip needed.
    assert not any(p.endswith("/tools/resolve") for p in paths)


async def test_loop_sends_tool_refs_not_an_inline_schema_for_decorated_tools():
    get_weather = _weather_tool()

    bodies: List[Dict[str, Any]] = []
    inner = tool_loop_handler()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            bodies.append(json.loads(request.content))
        return inner(request)

    async with make_client(handler) as client:
        await client.gateway.run_tool_loop(
            model="m", messages=[{"role": "user", "content": "?"}], tools=[get_weather]
        )

    # The catalog serves the schema, so the derived one can never diverge from it.
    assert bodies[0]["tool_refs"] == [{"name": "get_weather", "alias": "production"}]
    assert "tools" not in bodies[0]


async def test_loop_runs_an_http_executor_on_the_platform_and_writes_no_tool_span():
    paths: List[str] = []
    async with make_client(tool_loop_handler(executor_type="http", calls=paths)) as client:
        result = await client.gateway.run_tool_loop(
            model="m",
            messages=[{"role": "user", "content": "?"}],
            tool_refs=[{"name": "get_weather", "alias": "production"}],
        )

    assert result.content == "It is 30C."
    assert any(p.endswith("/tools/t-1/execute") for p in paths)
    # The platform records the tool span for a server-side execution; reporting one
    # here as well would show the same call twice in the waterfall.
    assert not any(p.endswith("/traces") for p in paths)


async def test_loop_raises_before_the_model_when_a_client_ref_has_no_dispatch():
    paths: List[str] = []
    async with make_client(tool_loop_handler(executor_type="client", calls=paths)) as client:
        with pytest.raises(AcruxCoreError) as exc:
            await client.gateway.run_tool_loop(
                model="m",
                messages=[{"role": "user", "content": "?"}],
                tool_refs=[{"name": "get_weather"}],
            )

    assert exc.value.code == "MISSING_DISPATCH"
    assert "get_weather" in str(exc.value)
    # Failing fast matters: no tokens were spent finding this out.
    assert not any(p.endswith("/gateway/chat/completions") for p in paths)


async def test_loop_still_accepts_a_dispatch_for_a_client_ref():
    async def dispatch(name: str, args: dict) -> Any:
        return {"temp_c": 30}

    async with make_client(tool_loop_handler(executor_type="client")) as client:
        result = await client.gateway.run_tool_loop(
            model="m",
            messages=[{"role": "user", "content": "?"}],
            tool_refs=[{"name": "get_weather"}],
            dispatch=dispatch,
        )
    assert result.content == "It is 30C."


async def test_a_decorated_function_wins_over_a_ref_of_the_same_name():
    """The caller wrote the body, so running it elsewhere would ignore their code."""
    ran: List[str] = []
    get_weather = _weather_tool(ran)

    paths: List[str] = []
    async with make_client(tool_loop_handler(executor_type="http", calls=paths)) as client:
        result = await client.gateway.run_tool_loop(
            model="m",
            messages=[{"role": "user", "content": "?"}],
            tools=[get_weather],
            tool_refs=[{"name": "get_weather"}],
        )

    assert result.content == "It is 30C."
    assert ran == ["Lahore"]
    # Despite the ref resolving to an http executor, the local function ran.
    assert not any(p.endswith("/tools/t-1/execute") for p in paths)


async def test_loop_records_the_tool_version_on_a_locally_run_span():
    get_weather = _weather_tool()

    reported: List[Dict[str, Any]] = []
    inner = tool_loop_handler()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/traces"):
            reported.append(json.loads(request.content))
        return inner(request)

    async with make_client(handler) as client:
        await client.gateway.run_tool_loop(
            model="m", messages=[{"role": "user", "content": "?"}], tools=[get_weather]
        )

    span = reported[0]["traces"][0]["spans"][0]
    assert span["kind"] == "tool"
    assert span["name"] == "get_weather"
    # The gap this closes: a tool span used to carry only {"arguments": ...}, so the
    # trace could not say which version of the tool ran.
    assert span["attributes"]["executorType"] == "client"
    assert span["attributes"]["toolVersionId"] == "t-1:1"


async def test_tool_defs_carries_raw_openai_definitions_and_needs_dispatch():
    async def dispatch(name: str, args: dict) -> Any:
        return {"temp_c": 30}

    bodies: List[Dict[str, Any]] = []
    inner = tool_loop_handler()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gateway/chat/completions"):
            bodies.append(json.loads(request.content))
        return inner(request)

    raw = [{"type": "function", "function": {"name": "get_weather", "parameters": {}}}]
    async with make_client(handler) as client:
        result = await client.gateway.run_tool_loop(
            model="m",
            messages=[{"role": "user", "content": "?"}],
            tool_defs=raw,
            dispatch=dispatch,
        )

    assert result.content == "It is 30C."
    assert bodies[0]["tools"] == raw


async def test_sync_false_skips_reconciliation():
    get_weather = _weather_tool()

    paths: List[str] = []
    async with make_client(tool_loop_handler(calls=paths)) as client:
        await client.gateway.run_tool_loop(
            model="m",
            messages=[{"role": "user", "content": "?"}],
            tools=[get_weather],
            sync=False,
        )
    assert not any(p.endswith("/tools/sync") for p in paths)


async def test_tools_rejects_an_undecorated_function_and_points_at_tool_defs():
    async def plain(city: str) -> dict:
        return {}

    async with make_client(tool_loop_handler()) as client:
        with pytest.raises(AcruxCoreError) as exc:
            await client.gateway.run_tool_loop(
                model="m", messages=[{"role": "user", "content": "?"}], tools=[plain]
            )
    assert "tool_defs=" in str(exc.value)


def test_dunder_version_matches_the_published_package_version():
    """`acruxcore.__version__` had drifted from pyproject.toml's version since the
    0.6.0 -> 0.6.5 release (the release step bumps pyproject.toml/PyPI but this
    constant is hand-maintained) — anyone introspecting `acruxcore.__version__` at
    runtime got a stale answer. Pinned here so a future release bump can't silently
    forget it again."""
    import tomllib
    from pathlib import Path

    import acruxcore

    pyproject = tomllib.loads((Path(__file__).parent.parent / "pyproject.toml").read_text())
    assert acruxcore.__version__ == pyproject["project"]["version"]
