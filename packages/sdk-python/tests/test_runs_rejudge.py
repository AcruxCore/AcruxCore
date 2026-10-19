"""Unit tests for ``client.runs.rejudge`` (issue #639): the request it sends and the
result it returns. The endpoint's behaviour is tested against a real database in
``apps/api/src/evaluations/runs/runs.rejudge.test.ts``."""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError


def make_client(handler: Any) -> AcruxCore:
    return AcruxCore(
        api_key="test-key",
        base_url="http://localhost:3000/api/v1",
        transport=httpx.MockTransport(handler),
        retry_interval=1,
    )


async def test_rejudge_defaults_to_only_unscored():
    seen: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append({"method": request.method, "path": request.url.path, "body": json.loads(request.content)})
        return httpx.Response(202, json={"run_id": "run-1", "status": "running", "rejudging": 9})

    async with make_client(handler) as hub:
        result = await hub.runs.rejudge("run-1")

    assert seen == [{"method": "POST", "path": "/api/v1/runs/run-1/rejudge", "body": {"only_unscored": True}}]
    assert (result.run_id, result.status, result.rejudging) == ("run-1", "running", 9)


async def test_rejudge_all_sends_only_unscored_false():
    bodies: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"run_id": "run-1", "status": "succeeded", "rejudging": 0})

    async with make_client(handler) as hub:
        result = await hub.runs.rejudge("run-1", only_unscored=False)

    assert bodies == [{"only_unscored": False}]
    assert result.rejudging == 0
    assert result.status == "succeeded"


async def test_rejudge_raises_on_a_run_in_flight():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={"error": {"code": "RUN_IN_FLIGHT", "message": "This run is still running. Wait for it to finish, then re-judge it."}},
        )

    async with make_client(handler) as hub:
        with pytest.raises(AcruxCoreError) as err:
            await hub.runs.rejudge("run-1")

    assert err.value.status_code == 409
    assert err.value.body["error"]["code"] == "RUN_IN_FLIGHT"
