"""Integration tests for ``client.sessions`` — listing and reading one
session's detail — against a real (subprocess) ``apps/api`` server + real
Postgres.

Mirrors the TypeScript SDK's ``sessions.integration.test.ts``: same real
server, seeded via the SDK's own ``trace()`` (see
``test_traces_analytics.py``'s module docstring for why). Uses the same
lightweight sign-up-only ``team_ctx``/``hub`` fixtures as that file (no
``GET /auth/me`` call needed here since this suite has no team-scoped-key
error case).
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
    gateway connection, no prompt, no skip-if-no-provider-creds.

    :param api_server: The running server's base URL.
    :returns: ``{"base_url", "api_key"}``.
    """
    with httpx.Client(base_url=api_server, timeout=30.0) as c:
        email = f"test-user-{uuid.uuid4()}@example.com"
        signup = c.post(
            "/auth/sign-up/email",
            json={"email": email, "password": _TEST_PASSWORD, "name": "Test User"},
        )
        assert signup.status_code == 200, signup.text
        cookie = _session_cookie(signup)

        key_res = c.post("/api-keys", json={"name": "test key"}, headers={"Cookie": cookie})
        assert key_res.status_code == 201, key_res.text
        api_key = key_res.json()["key"]

    return {"base_url": api_server, "api_key": api_key}


@pytest_asyncio.fixture()
async def hub(team_ctx: Dict[str, Any]) -> Iterator[AcruxCore]:
    """A fresh :class:`AcruxCore` client for ``team_ctx``'s API key."""
    client = AcruxCore(api_key=team_ctx["api_key"], base_url=team_ctx["base_url"], max_retries=0)
    try:
        yield client
    finally:
        await client.gateway.aclose()


@pytest.mark.asyncio
async def test_lists_sessions_and_reads_one_back_with_its_traces_unknown_404s(
    hub: AcruxCore,
) -> None:
    """Chain: seed two traces under two distinct session ids, list both back,
    read one session's detail, then confirm an unknown session id 404s.
    """
    now = _now_iso()
    session_id_a = f"sess-alpha-{uuid.uuid4()}"
    session_id_b = f"sess-beta-{uuid.uuid4()}"

    trace_a = await hub.traces.ingest(
        {
            "sessionId": session_id_a,
            "name": "alpha-run",
            "tags": ["support"],
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
                    "costUsd": 0.001,
                }
            ],
        }
    )
    await hub.traces.ingest(
        {
            "sessionId": session_id_b,
            "name": "beta-run",
            "spans": [
                {
                    "spanId": "b1",
                    "name": "claude-sonnet-5",
                    "kind": "llm",
                    "status": "error",
                    "startTime": now,
                    "endTime": now,
                    "model": "claude-sonnet-5",
                }
            ],
        }
    )

    # Both sessions appear in the list.
    listing = await hub.sessions.list()
    assert listing.total == 2
    assert sorted(s.session_id for s in listing.data) == sorted([session_id_a, session_id_b])

    # One session's detail — summary plus its traces.
    detail = await hub.sessions.get(session_id_a)
    assert detail.session.session_id == session_id_a
    assert detail.session.trace_count == 1
    assert len(detail.traces) == 1
    assert detail.traces[0].id == trace_a.trace_id
    assert detail.traces[0].session_id == session_id_a
    assert detail.traces[0].tags == ["support"]

    # An unknown session id 404s.
    with pytest.raises(AcruxCoreError) as exc:
        await hub.sessions.get("does-not-exist")
    assert exc.value.code == "API_ERROR"
    assert exc.value.status_code == 404
