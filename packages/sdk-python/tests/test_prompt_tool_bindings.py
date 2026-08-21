"""Unit tests for ``client.prompts.*tool_binding*`` — the six prompt→tool binding
endpoints. Drives the real client through a mocked httpx transport, so the request
building and response parsing run exactly as they would against the live API.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError
from acruxcore.cache import _reset_cache_for_testing

pytestmark = pytest.mark.asyncio

DETAIL: Dict[str, Any] = {
    "toolId": "tool-1",
    "toolName": "get_weather",
    "toolAlias": "production",
    "pinnedVersionNumber": None,
    "off": False,
    "resolvedVersionNumber": 3,
    "position": 0,
}


@pytest.fixture(autouse=True)
def _reset_cache():
    _reset_cache_for_testing()
    yield
    _reset_cache_for_testing()


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> AcruxCore:
    return AcruxCore(
        api_key="test-key",
        base_url="http://localhost:3000/api/v1",
        transport=httpx.MockTransport(handler),
        retry_interval=1,
    )


def body_of(request: httpx.Request) -> Dict[str, Any]:
    return json.loads(request.content.decode("utf-8")) if request.content else {}


async def test_list_tool_bindings_unwraps_the_data_envelope():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["method"] = request.method
        return httpx.Response(
            200,
            json={
                "data": {
                    "default": [DETAIL],
                    "aliases": [
                        {"alias": "production", "versionNumber": 2, "customised": False, "bindings": []},
                        {"alias": "staging", "versionNumber": 2, "customised": True, "bindings": [DETAIL]},
                    ],
                }
            },
        )

    async with make_client(handler) as c:
        bindings = await c.prompts.list_tool_bindings("p-1")

    assert seen["method"] == "GET"
    assert seen["path"] == "/api/v1/prompts/p-1/tools"
    assert [b.tool_name for b in bindings.default] == ["get_weather"]
    assert bindings.default[0].resolved_version_number == 3
    assert [a.customised for a in bindings.aliases] == [False, True]
    assert bindings.aliases[0].bindings == []
    assert bindings.aliases[1].bindings[0].tool_id == "tool-1"


async def test_set_tool_binding_puts_a_snake_case_tool_alias_body():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["method"] = request.method
        seen["body"] = body_of(request)
        return httpx.Response(200, json=DETAIL)

    async with make_client(handler) as c:
        result = await c.prompts.set_tool_binding("p-1", "tool-1", tool_alias="production")

    assert seen["method"] == "PUT"
    assert seen["path"] == "/api/v1/prompts/p-1/tools/tool-1"
    assert seen["body"] == {"tool_alias": "production"}
    assert result.tool_alias == "production"
    assert result.off is False


async def test_set_tool_binding_sends_a_pin_as_pinned_version_number():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = body_of(request)
        return httpx.Response(
            200,
            json={**DETAIL, "toolAlias": None, "pinnedVersionNumber": 2, "resolvedVersionNumber": 2},
        )

    async with make_client(handler) as c:
        result = await c.prompts.set_tool_binding("p-1", "tool-1", pinned_version_number=2)

    assert seen["body"] == {"pinned_version_number": 2}
    assert result.pinned_version_number == 2
    assert result.tool_alias is None


async def test_remove_tool_binding_accepts_204_and_raises_on_404():
    def ok(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.url.path == "/api/v1/prompts/p-1/tools/tool-1"
        return httpx.Response(204)

    async with make_client(ok) as c:
        assert await c.prompts.remove_tool_binding("p-1", "tool-1") is None

    def missing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "no such binding"}})

    async with make_client(missing) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.prompts.remove_tool_binding("p-1", "tool-1")
    assert ei.value.status_code == 404


async def test_set_alias_tool_binding_targets_the_alias_scoped_path():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = body_of(request)
        return httpx.Response(200, json={**DETAIL, "toolAlias": "staging"})

    async with make_client(handler) as c:
        result = await c.prompts.set_alias_tool_binding(
            "p-1", "staging", "tool-1", tool_alias="staging"
        )

    assert seen["path"] == "/api/v1/prompts/p-1/aliases/staging/tools/tool-1"
    assert seen["body"] == {"tool_alias": "staging"}
    assert result.tool_alias == "staging"


async def test_set_alias_tool_binding_sends_off_for_a_deliberate_exclusion():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = body_of(request)
        return httpx.Response(
            200, json={**DETAIL, "toolAlias": None, "off": True, "resolvedVersionNumber": None}
        )

    async with make_client(handler) as c:
        result = await c.prompts.set_alias_tool_binding("p-1", "staging", "tool-1", off=True)

    assert seen["body"] == {"off": True}
    assert result.off is True
    assert result.resolved_version_number is None


async def test_off_is_rejected_on_the_default_binding_before_sending():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        calls["n"] += 1
        return httpx.Response(200, json=DETAIL)

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.prompts.set_tool_binding("p-1", "tool-1", off=True)

    assert ei.value.code == "VALIDATION_ERROR"
    assert calls["n"] == 0


@pytest.mark.parametrize(
    "kwargs",
    [{}, {"tool_alias": "production", "pinned_version_number": 2}],
    ids=["no-target", "two-targets"],
)
async def test_a_binding_needs_exactly_one_target(kwargs):
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        calls["n"] += 1
        return httpx.Response(200, json=DETAIL)

    async with make_client(handler) as c:
        with pytest.raises(AcruxCoreError) as ei:
            await c.prompts.set_alias_tool_binding("p-1", "staging", "tool-1", **kwargs)

    assert ei.value.code == "VALIDATION_ERROR"
    assert calls["n"] == 0


async def test_remove_and_reset_target_the_right_alias_paths():
    seen: Dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.setdefault("paths", []).append(request.url.path)
        seen.setdefault("methods", []).append(request.method)
        return httpx.Response(204)

    async with make_client(handler) as c:
        await c.prompts.remove_alias_tool_binding("p-1", "staging", "tool-1")
        await c.prompts.reset_alias_tool_bindings("p-1", "staging")

    assert seen["paths"] == [
        "/api/v1/prompts/p-1/aliases/staging/tools/tool-1",
        "/api/v1/prompts/p-1/aliases/staging/tools",
    ]
    assert seen["methods"] == ["DELETE", "DELETE"]


async def test_render_reports_which_binding_resolved_each_tool():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "messages": [{"role": "user", "content": "Hi"}],
                "tools": [{"type": "function", "function": {"name": "get_weather"}}],
                "toolResolutions": [
                    {"name": "get_weather", "alias": "staging", "versionNumber": 4, "source": "alias"}
                ],
            },
        )

    async with make_client(handler) as c:
        rendered = await c.prompts.render("greeting", "staging")

    assert len(rendered.tool_resolutions) == 1
    resolution = rendered.tool_resolutions[0]
    assert resolution.name == "get_weather"
    assert resolution.alias == "staging"
    assert resolution.version_number == 4
    assert resolution.source == "alias"


async def test_render_defaults_source_to_default_when_the_response_omits_it():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "messages": [{"role": "user", "content": "Hi"}],
                "toolResolutions": [{"name": "get_weather", "alias": "production", "versionNumber": 1}],
            },
        )

    async with make_client(handler) as c:
        rendered = await c.prompts.render("greeting", "production")

    assert rendered.tool_resolutions[0].source == "default"
