"""A provider failure that can never succeed is sent once, not retried (issue #737).

The SDK retries every 5xx. A connection whose ``base_url`` the gateway refuses fails the
same way on every attempt, so a 5xx there wrote one gateway request row (and one red
trace) per attempt. The gateway answers it with a 409, which the SDK does not retry.

Runs against the real apps/api from the ``api_server`` fixture. The connection points at
``localhost``, which the gateway blocks at request time, so no provider key or network
access is needed.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError

from conftest import _TEST_PASSWORD, _session_cookie


async def test_blocked_connection_is_called_once(api_server: str) -> None:
    async with httpx.AsyncClient(base_url=api_server, timeout=30.0) as c:
        signup = await c.post(
            "/auth/sign-up/email",
            json={"email": f"test-user-{uuid.uuid4()}@example.com", "password": _TEST_PASSWORD, "name": "Test User"},
        )
        assert signup.status_code == 200, signup.text
        headers = {"Cookie": _session_cookie(signup)}

        key = await c.post("/api-keys", json={"name": "test key"}, headers=headers)
        assert key.status_code == 201, key.text

        # A hostname, not a literal address: the save-time check refuses a literal
        # loopback, so only the request-time guard can stop this one.
        conn = await c.post(
            "/gateway/connections",
            json={
                "provider": "openai_compatible",
                "label": "blocked address",
                "apiKey": "sk-test-unused",
                "config": {"base_url": "http://localhost:9/v1"},
            },
            headers=headers,
        )
        assert conn.status_code == 201, conn.text
        model = await c.post(
            "/gateway/models",
            json={"publicName": "blocked-model", "upstreamModel": "gpt-4o-mini", "credentialId": conn.json()["id"]},
            headers=headers,
        )
        assert model.status_code == 201, model.text

        # max_retries=1 is the default; stated so the test fails if the default changes
        # rather than passing for the wrong reason.
        async with AcruxCore(api_key=key.json()["key"], base_url=api_server, max_retries=1) as hub:
            with pytest.raises(AcruxCoreError) as caught:
                await hub.gateway.chat(model="blocked-model", messages=[{"role": "user", "content": "hi"}])

        assert caught.value.status_code == 409
        assert caught.value.body["error"]["code"] == "PROVIDER_ADDRESS_BLOCKED"

        rows = await c.get("/gateway/requests", headers=headers)
        assert rows.status_code == 200, rows.text
        assert len(rows.json()["data"]) == 1
