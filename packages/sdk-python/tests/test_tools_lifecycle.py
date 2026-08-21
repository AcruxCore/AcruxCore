"""Live-server tests for the tool-catalog lifecycle methods added to
``client.tools`` in this branch: shell CRUD, version commit/list/get, alias
promote, analytics.

Unlike ``test_tools_api.py`` (all mocked, no network), these tests boot a real
``apps/api`` subprocess via ``conftest.py``'s session-scoped ``api_server``
fixture and drive it with a real ``AcruxCore`` client over real HTTP — the same
approach ``test_byo_integration.py`` uses. This file deliberately does NOT use
``conftest.py``'s ``provisioned_env`` fixture: that one requires OpenRouter
credentials (``ACRUXCORE_TEST_PROVIDER_BASE_URL``/``_API_KEY``) to provision a
real gateway connection + model, none of which this lifecycle testing needs —
it only ever calls the Tools Catalog endpoints, never the gateway. Each test
signs up its own fresh user (unique per-test email) and mints its own API key,
mirroring what ``provisioned_env`` does internally but skipping the
gateway/model/prompt provisioning entirely.
"""

from __future__ import annotations

import uuid
from typing import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from conftest import signup_and_mint_key

from acruxcore import AcruxCore, AcruxCoreError


@pytest_asyncio.fixture
async def hub(api_server: str) -> AsyncIterator[AcruxCore]:
    """A live ``AcruxCore`` client for a freshly signed-up user, one per test.

    Function-scoped (unlike conftest's session-scoped ``hub``) because each test
    below needs its own isolated team — tool names are unique per test anyway,
    but a shared team would let one test's `list`/`analytics` assertions see
    another test's rows.
    """
    api_key = await signup_and_mint_key(api_server)
    client = AcruxCore(api_key=api_key, base_url=api_server, max_retries=0)
    try:
        yield client
    finally:
        await client.gateway.aclose()


@pytest.mark.asyncio
async def test_full_tool_lifecycle_create_versions_promote_analytics_delete(hub: AcruxCore) -> None:
    # create -> get -> update
    created = await hub.tools.create(
        f"lifecycle_tool_{uuid.uuid4().hex[:8]}", description="Initial description"
    )
    assert isinstance(created.id, str) and created.id
    assert created.description == "Initial description"

    fetched = await hub.tools.get(created.id)
    assert fetched == created

    updated = await hub.tools.update(created.id, description="Updated description")
    assert updated.description == "Updated description"
    assert updated.name == created.name

    # list — the created tool appears
    list_page = await hub.tools.list()
    assert created.id in [t.id for t in list_page.data]

    # commit_version v1 (client executor) — aliases present (first version mints both)
    v1 = await hub.tools.commit_version(
        created.id,
        {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        {"type": "client"},
    )
    assert v1.version_number == 1
    assert v1.tool_id == created.id
    assert v1.aliases is not None
    assert sorted(a.alias for a in v1.aliases) == ["production", "staging"]
    assert all(a.version_number == 1 for a in v1.aliases)
    assert v1.warnings is None

    # commit_version v2 (http executor) — aliases absent (committing never moves an alias by itself)
    # This executor is only ever stored and read back, never executed. The host is
    # still IANA's reserved `example.com` rather than an arbitrary third party — but
    # it has to be one that RESOLVES, because committing an `http` executor runs the
    # SSRF guard (`versions.service.ts` → `assertPublicUrl`), which fails closed on a
    # name that does not resolve. A subdomain like `api.example.com` does not.
    http_executor = {
        "type": "http",
        "url": "https://example.com/weather",
        "method": "GET",
        "headers": [],
        "query": [{"name": "city", "value": "{{city}}"}],
        "argMapping": [{"arg": "city", "in": "query"}],
    }
    v2 = await hub.tools.commit_version(
        created.id,
        {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        http_executor,
        description="Looks up the weather via a public API",
    )
    assert v2.version_number == 2
    assert v2.aliases is None
    assert v2.warnings is None
    assert v2.executor == http_executor

    # commit_version v3 (changelog only, no description) — warnings present
    v3 = await hub.tools.commit_version(
        created.id,
        {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        {"type": "client"},
        changelog="Tweaked argument mapping",
    )
    assert v3.version_number == 3
    assert v3.aliases is None
    assert v3.warnings is not None
    assert len(v3.warnings) > 0

    # list_versions — newest first, no parameters_schema/executor on list items
    versions_page = await hub.tools.list_versions(created.id)
    assert versions_page.total == 3
    assert [v.version_number for v in versions_page.data] == [3, 2, 1]
    assert versions_page.data[0].tool_id == created.id

    # Assert against the raw response body, not the parsed dataclass: `from_dict`
    # only ever maps the fields `ToolVersionListItem` declares, so an assertion
    # against the dataclass can't fail even if the API started incorrectly
    # returning parametersSchema/executor on list items. Hitting the same
    # endpoint directly and checking the parsed JSON dict's keys is the only way
    # to actually guard against that regression.
    raw_response = await hub._request(
        "GET", f"/tools/{created.id}/versions", None, "listing tool versions"
    )
    raw_first_item = raw_response.json()["data"][0]
    assert "parametersSchema" not in raw_first_item
    assert "executor" not in raw_first_item

    # get_version — full parameters_schema/executor present, never aliases/warnings
    got_v2 = await hub.tools.get_version(created.id, 2)
    assert got_v2.parameters_schema == v2.parameters_schema
    assert got_v2.executor == v2.executor
    assert got_v2.aliases is None
    assert got_v2.warnings is None

    # promote_alias — move `production` to v2
    promoted = await hub.tools.promote_alias(created.id, "production", 2)
    assert promoted.alias == "production"
    assert promoted.version_number == 2

    # analytics — no executions happened in this test
    analytics = await hub.tools.analytics()
    assert analytics.data == []

    # delete -> get on the deleted id throws API_ERROR / 404
    await hub.tools.delete(created.id)
    with pytest.raises(AcruxCoreError) as exc:
        await hub.tools.get(created.id)
    assert exc.value.code == "API_ERROR"
    assert exc.value.status_code == 404


#: Upstream for the server-side `http` executor test below. IANA's reserved
#: `example.com` rather than `httpbin.org`: it exists precisely to be a stable
#: target, answers a plain 200, and has no rate limit to trip over.
#:
#: It cannot be our own `api_server`, tempting as that is. Committing an `http`
#: executor runs the SSRF guard, which blocks loopback and has NO env or
#: NODE_ENV bypass by design (`apps/api/src/tools/execute/safe-fetch.ts`). The
#: only seam is `allowLoopbackForTests()`, which opens the hole in-process —
#: reachable from the Node suite, which boots the app in-process, but not from
#: here, where the server is a subprocess. Widening the guard to suit a test
#: would be a real security regression, so this suite uses a public host and
#: skips when it cannot be reached (issue #331).
_EXECUTOR_UPSTREAM = "https://example.com/"


@pytest.mark.asyncio
async def test_execute_http_tool(hub: AcruxCore) -> None:
    """The server-side ``http`` executor makes a real outbound request.

    Skips rather than fails when the upstream is unreachable. That is the whole
    point of issue #331: this test used to point at ``https://httpbin.org/get``
    and failed twice in a row on 2026-08-20 (a 503, then a 400) while nothing in
    our code had changed. A suite that goes red for someone else's downtime stops
    meaning "we broke something". What the test covers is unchanged: URL
    templating, query-arg mapping, status capture, latency.
    """
    async with httpx.AsyncClient(timeout=10.0) as probe:
        try:
            reachable = await probe.get(_EXECUTOR_UPSTREAM)
        except httpx.HTTPError as err:
            pytest.skip(f"executor upstream {_EXECUTOR_UPSTREAM} unreachable: {err}")
        if reachable.status_code != 200:
            pytest.skip(
                f"executor upstream {_EXECUTOR_UPSTREAM} answered "
                f"{reachable.status_code}, not 200"
            )

    created = await hub.tools.create(
        f"http_exec_{uuid.uuid4().hex[:8]}", description="HTTP GET via the server-side executor"
    )
    assert isinstance(created.id, str) and created.id

    http_executor = {
        "type": "http",
        "url": _EXECUTOR_UPSTREAM,
        "method": "GET",
        "headers": [],
        "query": [{"name": "city", "value": "{{city}}"}],
        "argMapping": [{"arg": "city", "in": "query"}],
    }
    v1 = await hub.tools.commit_version(
        created.id,
        {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
        http_executor,
        description="HTTP GET via the server-side executor",
    )
    assert v1.version_number == 1

    result = await hub.tools.execute(created.id, {"city": "Berlin"})

    assert result.result is not None
    assert result.status == 200
    assert result.latency_ms >= 0
    assert isinstance(result.tool_version_id, str) and result.tool_version_id


@pytest.mark.asyncio
async def test_tool_error_paths_validation_name_taken_404s(hub: AcruxCore) -> None:
    # create: VALIDATION_ERROR on a bad name
    with pytest.raises(AcruxCoreError) as exc:
        await hub.tools.create("bad name!")
    assert exc.value.code == "API_ERROR"
    assert exc.value.status_code == 400
    assert exc.value.body["error"]["code"] == "VALIDATION_ERROR"

    # create: TOOL_NAME_TAKEN (409) on a duplicate name within the same team
    tool_name = f"taken_name_{uuid.uuid4().hex[:8]}"
    first = await hub.tools.create(tool_name)
    assert isinstance(first.id, str) and first.id

    with pytest.raises(AcruxCoreError) as exc:
        await hub.tools.create(tool_name)
    assert exc.value.status_code == 409
    assert exc.value.body["error"]["code"] == "TOOL_NAME_TAKEN"

    # get_version: 404 for a version number that doesn't exist
    await hub.tools.commit_version(
        first.id, {"type": "object", "properties": {}}, {"type": "client"}
    )
    with pytest.raises(AcruxCoreError) as exc:
        await hub.tools.get_version(first.id, 99)
    assert exc.value.code == "API_ERROR"
    assert exc.value.status_code == 404

    # analytics: VALIDATION_ERROR on a non-ISO-8601 `since`
    with pytest.raises(AcruxCoreError) as exc:
        await hub.tools.analytics(since="not-a-date")
    assert exc.value.status_code == 400
    assert exc.value.body["error"]["code"] == "VALIDATION_ERROR"
