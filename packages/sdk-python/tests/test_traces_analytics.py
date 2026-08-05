"""Integration tests for ``client.traces`` — analytics, facet discovery,
payload-capture settings, and feedback summary/list — against a real
(subprocess) ``apps/api`` server + real Postgres.

Mirrors the TypeScript SDK's ``traces-analytics.integration.test.ts``: real
server, seeded via the SDK's own ``trace()`` (there is no separate SDK wrapper
for an arbitrary multi-span batch, and ``trace()`` posts to the same
``/traces`` endpoint a raw ``POST`` would — same choice Task 1's TS suite
made, and the reasoning holds here too), same assertions translated to this
SDK's snake_case attribute names.

Deliberately does NOT use ``conftest.py``'s ``provisioned_env`` fixture: that
fixture requires ``ACRUXCORE_TEST_PROVIDER_BASE_URL``/``_API_KEY`` and
registers a real gateway connection, neither of which this domain needs, and
it ``pytest.skip()``s the whole suite without those creds. This file
provisions its own lightweight team (sign-up + ``GET /auth/me`` for the team
id + one personal API key — the same three ``httpx`` calls
``signupTestUserWithApiKey`` makes on the TypeScript side) on top of the
shared, session-scoped ``api_server`` fixture instead, fresh per test so no
truncation between tests is needed.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterator

import httpx
import pytest
import pytest_asyncio

from acruxcore import AcruxCore, AcruxCoreError

#: Password used for every test account created by this file. Never leaves this process.
_TEST_PASSWORD = "test-password-not-a-real-one-1234"


def _session_cookie(response: httpx.Response) -> str:
    """Extracts the ``name=value`` session cookie pair from a sign-up response."""
    raw = response.headers.get("set-cookie")
    if not raw or "session_token" not in raw:
        raise RuntimeError(
            f"No session cookie in sign-up response (status {response.status_code}): "
            f"{response.text}"
        )
    return raw.split(";")[0]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@pytest.fixture()
def team_ctx(api_server: str) -> Dict[str, Any]:
    """Signs up a fresh user + team on the live ``api_server`` and mints one
    personal API key. Lighter than ``conftest.py``'s ``provisioned_env`` — no
    gateway connection, no prompt, no skip-if-no-provider-creds. Fresh per
    test, so each test gets an untouched team (matters for the "fresh test
    team, never written" settings-default assertion below).

    :param api_server: The running server's base URL.
    :returns: ``{"base_url", "api_key", "cookie", "team_id"}``.
    """
    with httpx.Client(base_url=api_server, timeout=30.0) as c:
        email = f"test-user-{uuid.uuid4()}@example.com"
        signup = c.post(
            "/auth/sign-up/email",
            json={"email": email, "password": _TEST_PASSWORD, "name": "Test User"},
        )
        assert signup.status_code == 200, signup.text
        cookie = _session_cookie(signup)
        headers = {"Cookie": cookie}

        me = c.get("/auth/me", headers=headers)
        assert me.status_code == 200, me.text
        team_id = me.json()["team"]["id"]

        key_res = c.post("/api-keys", json={"name": "test key"}, headers=headers)
        assert key_res.status_code == 201, key_res.text
        api_key = key_res.json()["key"]

    return {"base_url": api_server, "api_key": api_key, "cookie": cookie, "team_id": team_id}


@pytest_asyncio.fixture()
async def hub(team_ctx: Dict[str, Any]) -> Iterator[AcruxCore]:
    """A fresh :class:`AcruxCore` client for ``team_ctx``'s API key. ``max_retries=0``
    matches the TS suite's ``maxRetries: 0`` — a real error should surface immediately,
    not after a retry delay."""
    client = AcruxCore(api_key=team_ctx["api_key"], base_url=team_ctx["base_url"], max_retries=0)
    try:
        yield client
    finally:
        await client.gateway.aclose()


@pytest.mark.asyncio
async def test_analytics_facets_settings_and_feedback_read_back_what_was_ingested(
    hub: AcruxCore,
) -> None:
    """One chain test covering every ``client.traces`` read, in the order a
    caller would naturally use them: seed two traces, then analytics (default
    and grouped), facets, facet values, settings (default then updated), and
    feedback (summary, list, per-trace) — each assertion reading back exactly
    what the seeding step wrote.
    """
    now = _now_iso()

    trace_a = await hub.traces.ingest(
        {
            "sessionId": f"sess-alpha-{uuid.uuid4()}",
            "name": "alpha-run",
            "tags": ["support"],
            "metadata": {"region": "us-east"},
            "spans": [
                {
                    "spanId": "a1",
                    "name": "gpt-4o-mini",
                    "kind": "llm",
                    "status": "ok",
                    "startTime": now,
                    "endTime": now,
                    "model": "gpt-4o-mini",
                    "usage": {"promptTokens": 50, "completionTokens": 10, "totalTokens": 60},
                }
            ],
        }
    )
    trace_b = await hub.traces.ingest(
        {
            "sessionId": f"sess-beta-{uuid.uuid4()}",
            "name": "beta-run",
            "tags": ["escalation"],
            "metadata": {"region": "eu-west"},
            "spans": [
                {
                    "spanId": "b1",
                    "name": "claude-sonnet-5",
                    "kind": "llm",
                    "status": "error",
                    "startTime": now,
                    "endTime": now,
                    "model": "claude-sonnet-5",
                    "usage": {"promptTokens": 40, "completionTokens": 5, "totalTokens": 45},
                    "error": "upstream 500",
                }
            ],
        }
    )

    # 1. Default analytics — one span each, so requests == 2 spans total.
    totals = await hub.traces.analytics()
    assert totals.totals.requests == 2

    # 2. Grouped by model — one bucket per model, with per-model metrics.
    by_model = await hub.traces.analytics(group_by="model")
    assert by_model.group_by == "model"
    assert len(by_model.buckets) == 2
    alpha_bucket = next(b for b in by_model.buckets if b.key == "gpt-4o-mini")
    beta_bucket = next(b for b in by_model.buckets if b.key == "claude-sonnet-5")
    assert alpha_bucket.requests == 1
    assert alpha_bucket.error_rate == 0
    assert beta_bucket.requests == 1
    assert beta_bucket.error_rate == 1

    # 3. Facets — the seeded tags and metadata key appear.
    facets = await hub.traces.list_facets()
    assert sorted(facets.tags) == ["escalation", "support"]
    assert facets.metadata_keys == ["region"]

    # 4. Facet values — the seeded values for that metadata key.
    values = await hub.traces.get_facet_values("region")
    assert sorted(values.values) == ["eu-west", "us-east"]

    # 5. Settings default — fresh test team, never written.
    default_settings = await hub.traces.get_settings()
    assert default_settings.capture_payloads is True
    assert default_settings.updated_at is None

    # 6. Update settings, then confirm it persisted on a second read.
    updated = await hub.traces.update_settings(False)
    assert updated.capture_payloads is False
    assert updated.updated_at is not None
    reread = await hub.traces.get_settings()
    assert reread.capture_payloads is False
    assert reread.updated_at == updated.updated_at

    # 7. Attach feedback, then read it back three ways.
    feedback = await hub.traces.submit_feedback(trace_a.trace_id, rating=5)

    summary = await hub.traces.get_feedback_summary(group_by="model")
    assert summary.group_by == "model"
    assert len(summary.buckets) == 1
    bucket = summary.buckets[0]
    assert bucket.key == "gpt-4o-mini"
    assert bucket.count == 1
    assert bucket.avg_rating == 5
    assert bucket.down_count == 0

    listed = await hub.traces.list_feedback()
    assert listed.total == 1
    assert len(listed.data) == 1
    assert listed.data[0].id == feedback.id

    trace_feedback = await hub.traces.get_trace_feedback(trace_a.trace_id)
    assert len(trace_feedback.data) == 1
    assert trace_feedback.data[0].id == feedback.id

    assert trace_b.trace_id  # seeded but only used for the shared assertions above


@pytest.mark.asyncio
async def test_surfaces_validation_and_role_errors_as_api_error(
    hub: AcruxCore, team_ctx: Dict[str, Any]
) -> None:
    """Error-path companion to the chain test above: an empty ``key`` on
    ``get_facet_values`` 400s, and a team-scoped API key (no user identity)
    cannot write settings — 403.
    """
    # Empty key -> 400 VALIDATION_ERROR from the facets/values endpoint.
    with pytest.raises(AcruxCoreError) as exc:
        await hub.traces.get_facet_values("")
    assert exc.value.code == "API_ERROR"
    assert exc.value.status_code == 400

    # A team-scoped API key (no user identity) cannot write settings — 403.
    with httpx.Client(base_url=team_ctx["base_url"], timeout=30.0) as c:
        team_key_res = c.post(
            f"/teams/{team_ctx['team_id']}/api-keys",
            json={"name": "team key"},
            headers={"Cookie": team_ctx["cookie"]},
        )
        assert team_key_res.status_code == 201, team_key_res.text
        team_api_key = team_key_res.json()["key"]

    team_hub = AcruxCore(api_key=team_api_key, base_url=team_ctx["base_url"], max_retries=0)
    try:
        with pytest.raises(AcruxCoreError) as exc2:
            await team_hub.traces.update_settings(True)
        assert exc2.value.code == "API_ERROR"
        assert exc2.value.status_code == 403
    finally:
        await team_hub.gateway.aclose()
