"""A docstring-less ``@acrux.tool`` must still reach a BYO provider with its description.

Omitting the docstring is the documented way to hand the model-facing text to a
non-engineer in the dashboard. On the gateway path the gateway resolves ``tool_refs``
and substitutes the catalog definition, description included. A BYO provider gets only
what the SDK inlines, so the SDK has to do that resolution itself (issue #433).

Every test drives the real client through a mocked httpx transport — no network.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List

import httpx
import pytest

import acruxcore as acrux
from acruxcore import AcruxCore
from acruxcore.tools_api import _reset_sync_cache_for_testing

pytestmark = pytest.mark.asyncio

PROVIDER = {"base_url": "https://provider.invalid/v1", "api_key": "pk"}

PLAIN_COMPLETION = {
    "id": "chatcmpl-1",
    "model": "gpt-4o-mini",
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "Done."}, "finish_reason": "stop"}
    ],
}


@pytest.fixture(autouse=True)
def _clear_sync_cache() -> Any:
    # sync_one memoises by spec hash, so without this a second test reusing a tool name
    # would skip its own POST /tools/sync and never reach the resolve under test.
    _reset_sync_cache_for_testing()
    yield
    _reset_sync_cache_for_testing()


def make_tools() -> Any:
    """One tool with a docstring, one without — the two halves of the bug."""

    @acrux.tool
    def query_database(sql: str) -> str:
        """Run a read-only SQL SELECT against the store database."""
        return "[]"

    @acrux.tool
    def check_disclosure_policy(topic: str) -> str:
        return "ok"

    return query_database, check_disclosure_policy


def build_handler(
    calls: List[str],
    provider_bodies: List[Dict[str, Any]],
    *,
    catalog_description: str | None = "Check the topic against the store's disclosure policy.",
) -> Callable[[httpx.Request], httpx.Response]:
    """Stands in for both the platform API and the BYO provider."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls.append(path)
        if path.endswith("/tools/sync"):
            name = json.loads(request.content)["name"]
            return httpx.Response(
                200,
                json={
                    "toolId": f"t-{name}",
                    "versionNumber": 2,
                    "committed": True,
                    "alias": "production",
                },
            )
        if path.endswith("/tools/resolve"):
            refs = json.loads(request.content)["refs"]
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "toolId": f"t-{r['name']}",
                            "versionNumber": 2,
                            "executorType": "client",
                            "function": {
                                "name": r["name"],
                                **(
                                    {"description": catalog_description}
                                    if catalog_description is not None
                                    else {}
                                ),
                                "parameters": {"type": "object"},
                            },
                        }
                        for r in refs
                    ]
                },
            )
        if path.endswith("/traces"):
            return httpx.Response(200, json={"traceId": "tr-1"})
        provider_bodies.append(json.loads(request.content))
        return httpx.Response(200, json=PLAIN_COMPLETION)

    return handler


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> AcruxCore:
    return AcruxCore(
        api_key="k",
        base_url="http://localhost:3001/api/v1",
        transport=httpx.MockTransport(handler),
    )


def descriptions_of(body: Dict[str, Any]) -> Dict[str, Any]:
    return {t["function"]["name"]: t["function"].get("description") for t in body["tools"]}


async def test_byo_provider_gets_the_catalog_description_for_a_docstring_less_tool():
    calls: List[str] = []
    bodies: List[Dict[str, Any]] = []
    query_database, check_disclosure_policy = make_tools()

    async with make_client(build_handler(calls, bodies)) as hub:
        await hub.gateway.run_tool_loop(
            "gpt-4o-mini",
            [{"role": "user", "content": "Can I talk about this?"}],
            tools=[query_database, check_disclosure_policy],
            provider=PROVIDER,
        )

    assert descriptions_of(bodies[0]) == {
        "query_database": "Run a read-only SQL SELECT against the store database.",
        "check_disclosure_policy": "Check the topic against the store's disclosure policy.",
    }


async def test_only_the_undescribed_tool_costs_a_resolve_call():
    """The described tool must not drag an extra round trip into every BYO run."""
    calls: List[str] = []
    bodies: List[Dict[str, Any]] = []
    query_database, check_disclosure_policy = make_tools()

    async with make_client(build_handler(calls, bodies)) as hub:
        await hub.gateway.run_tool_loop(
            "gpt-4o-mini",
            [{"role": "user", "content": "hi"}],
            tools=[query_database, check_disclosure_policy],
            provider=PROVIDER,
        )

    resolves = [c for c in calls if c.endswith("/tools/resolve")]
    assert len(resolves) == 1


async def test_the_gateway_path_resolves_nothing_because_the_gateway_does_it():
    """No provider means the refs travel and the gateway substitutes the definition, so
    paying for a resolve here would be latency bought for nothing."""
    calls: List[str] = []
    bodies: List[Dict[str, Any]] = []
    query_database, check_disclosure_policy = make_tools()

    async with make_client(build_handler(calls, bodies)) as hub:
        await hub.gateway.run_tool_loop(
            "gpt-4o-mini",
            [{"role": "user", "content": "hi"}],
            tools=[query_database, check_disclosure_policy],
        )

    assert not [c for c in calls if c.endswith("/tools/resolve")]
    sent = bodies[0]
    assert {r["name"] for r in sent["tool_refs"]} == {"query_database", "check_disclosure_policy"}


async def test_a_tool_described_nowhere_warns_instead_of_going_out_silently():
    calls: List[str] = []
    bodies: List[Dict[str, Any]] = []
    _, check_disclosure_policy = make_tools()

    async with make_client(build_handler(calls, bodies, catalog_description=None)) as hub:
        with pytest.warns(UserWarning, match="check_disclosure_policy.*no description"):
            await hub.gateway.run_tool_loop(
                "gpt-4o-mini",
                [{"role": "user", "content": "hi"}],
                tools=[check_disclosure_policy],
                provider=PROVIDER,
            )

    assert descriptions_of(bodies[0]) == {"check_disclosure_policy": None}


async def test_sync_off_warns_rather_than_resolving_a_tool_that_may_not_exist():
    calls: List[str] = []
    bodies: List[Dict[str, Any]] = []
    _, check_disclosure_policy = make_tools()

    async with make_client(build_handler(calls, bodies)) as hub:
        with pytest.warns(UserWarning, match="sync=False"):
            await hub.gateway.run_tool_loop(
                "gpt-4o-mini",
                [{"role": "user", "content": "hi"}],
                tools=[check_disclosure_policy],
                provider=PROVIDER,
                sync=False,
            )

    assert not [c for c in calls if c.endswith("/tools/resolve")]


async def test_the_streaming_loop_fills_the_description_too():
    """The streaming loop prepares its own routes, so it can regress on its own."""
    calls: List[str] = []
    bodies: List[Dict[str, Any]] = []
    _, check_disclosure_policy = make_tools()

    def handler(request: httpx.Request) -> httpx.Response:
        if not request.url.host.startswith("provider"):
            return build_handler(calls, bodies)(request)
        calls.append(request.url.path)
        bodies.append(json.loads(request.content))
        frame = {
            "id": "chatcmpl-1",
            "model": "gpt-4o-mini",
            "choices": [{"index": 0, "delta": {"content": "Done."}, "finish_reason": "stop"}],
        }
        body = f"data: {json.dumps(frame)}\n\ndata: [DONE]\n\n".encode("utf-8")
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    async with make_client(handler) as hub:
        stream = await hub.gateway.run_tool_loop(
            "gpt-4o-mini",
            [{"role": "user", "content": "hi"}],
            tools=[check_disclosure_policy],
            provider=PROVIDER,
            stream=True,
        )
        async for _ in stream:
            pass

    assert descriptions_of(bodies[0]) == {
        "check_disclosure_policy": "Check the topic against the store's disclosure policy."
    }
