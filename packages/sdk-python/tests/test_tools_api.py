"""Unit tests for client.tools — sync, resolve and execute over a mocked transport.

No network: httpx.MockTransport runs the real request-building and response-parsing
code, so what is asserted here is the actual wire contract.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError, acrux
from acruxcore.tools_api import _reset_sync_cache_for_testing


@pytest.fixture(autouse=True)
def _reset():
    _reset_sync_cache_for_testing()
    yield
    _reset_sync_cache_for_testing()


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> AcruxCore:
    return AcruxCore(
        api_key="test-key",
        base_url="http://localhost:3000/api/v1",
        transport=httpx.MockTransport(handler),
        retry_interval=1,
    )


@acrux.tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. 'Lahore'.
    """
    return {"city": city, "temp_c": 18}


@acrux.tool
async def count_rows(table: str) -> int:
    return 0


@pytest.mark.asyncio
async def test_sync_posts_the_derived_spec_and_parses_the_result():
    seen: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/tools/sync")
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"toolId": "t-1", "versionNumber": 3, "committed": True, "alias": "production"},
        )

    async with make_client(handler) as client:
        results = await client.tools.sync([get_weather])

    assert len(results) == 1
    assert results[0].tool_id == "t-1"
    assert results[0].version_number == 3
    assert results[0].committed is True
    assert results[0].superseded_source is None

    body = seen[0]
    assert body["name"] == "get_weather"
    assert body["description"] == "Get the current weather for a city."
    assert body["executor"] == {"type": "client"}
    assert body["alias"] == "production"
    assert body["source"] == "code"
    assert body["parametersSchema"]["required"] == ["city"]


@pytest.mark.asyncio
async def test_a_function_without_a_docstring_sends_no_description():
    """Omitting the key is what hands description ownership to the dashboard."""
    seen: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"toolId": "t-2", "versionNumber": 1, "committed": True, "alias": "production"},
        )

    async with make_client(handler) as client:
        await client.tools.sync([count_rows])

    assert "description" not in seen[0]


@pytest.mark.asyncio
async def test_sync_is_cached_by_spec_so_a_second_call_makes_no_request():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200,
            json={"toolId": "t-1", "versionNumber": 1, "committed": True, "alias": "production"},
        )

    async with make_client(handler) as client:
        await client.tools.sync([get_weather])
        second = await client.tools.sync([get_weather])

    assert calls["n"] == 1
    # The cached result reports committed False: nothing was committed THIS time.
    assert second[0].committed is False
    assert second[0].tool_id == "t-1"


@pytest.mark.asyncio
async def test_sync_warns_when_it_supersedes_a_dashboard_version(recwarn):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "toolId": "t-1",
                "versionNumber": 4,
                "committed": True,
                "alias": "production",
                "supersededSource": "dashboard",
            },
        )

    async with make_client(handler) as client:
        results = await client.tools.sync([get_weather])

    assert results[0].superseded_source == "dashboard"
    messages = [str(w.message) for w in recwarn]
    assert any("get_weather" in m and "dashboard" in m for m in messages)
    assert any("v4" in m for m in messages)


@pytest.mark.asyncio
async def test_sync_with_on_conflict_error_raises_instead_of_warning():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "toolId": "t-1",
                "versionNumber": 4,
                "committed": True,
                "alias": "production",
                "supersededSource": "dashboard",
            },
        )

    async with make_client(handler) as client:
        with pytest.raises(AcruxCoreError) as exc:
            await client.tools.sync([get_weather], on_conflict="error")
    assert "dashboard" in str(exc.value)


@pytest.mark.asyncio
async def test_sync_rejects_an_undecorated_function():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    async def plain(city: str) -> dict:
        return {}

    async with make_client(handler) as client:
        with pytest.raises(AcruxCoreError) as exc:
            await client.tools.sync([plain])
    assert "@acrux.tool" in str(exc.value)


@pytest.mark.asyncio
async def test_resolve_posts_a_batch_and_parses_executor_types():
    seen: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/tools/resolve")
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "toolId": "t-1",
                        "versionNumber": 2,
                        "executorType": "http",
                        "function": {"name": "get_weather", "description": "W.", "parameters": {}},
                    }
                ]
            },
        )

    async with make_client(handler) as client:
        resolved = await client.tools.resolve([{"name": "get_weather", "alias": "production"}])

    assert seen[0] == {"refs": [{"name": "get_weather", "alias": "production"}]}
    assert resolved[0].executor_type == "http"
    assert resolved[0].tool_id == "t-1"
    assert resolved[0].name == "get_weather"


@pytest.mark.asyncio
async def test_resolve_omits_a_missing_alias_so_the_server_default_applies():
    seen: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"data": []})

    async with make_client(handler) as client:
        await client.tools.resolve([{"name": "get_weather"}])

    assert seen[0] == {"refs": [{"name": "get_weather"}]}


@pytest.mark.asyncio
async def test_resolve_surfaces_the_404_with_the_failing_refs():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={
                "error": {
                    "code": "TOOL_REF_NOT_FOUND",
                    "message": "nope",
                    "refs": [{"name": "ghost", "alias": "production"}],
                }
            },
        )

    async with make_client(handler) as client:
        with pytest.raises(AcruxCoreError) as exc:
            await client.tools.resolve([{"name": "ghost"}])
    assert exc.value.status_code == 404
    assert "ghost" in json.dumps(exc.value.body)


@pytest.mark.asyncio
async def test_execute_posts_arguments_and_trace_context():
    seen: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/tools/t-1/execute")
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"result": {"temp_c": 18}, "status": 200, "latencyMs": 42, "toolVersionId": "v-1"},
        )

    async with make_client(handler) as client:
        out = await client.tools.execute(
            "t-1", {"city": "Lahore"}, alias="production", trace_id="tr-1", parent_span_id="sp-1"
        )

    assert out.result == {"temp_c": 18}
    assert out.latency_ms == 42
    assert out.tool_version_id == "v-1"
    assert seen[0] == {
        "arguments": {"city": "Lahore"},
        "alias": "production",
        "traceContext": {"traceId": "tr-1", "parentSpanId": "sp-1"},
    }


@pytest.mark.asyncio
async def test_execute_sends_no_trace_context_when_none_is_given():
    seen: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(
            200, json={"result": 1, "status": 200, "latencyMs": 3, "toolVersionId": "v-1"}
        )

    async with make_client(handler) as client:
        await client.tools.execute("t-1", {"city": "Lahore"})

    assert seen[0] == {"arguments": {"city": "Lahore"}}
