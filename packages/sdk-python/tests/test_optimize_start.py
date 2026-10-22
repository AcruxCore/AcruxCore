"""Unit tests for ``client.optimize.start``: the request body it sends. The endpoint's
behaviour is tested against a real database in
``apps/api/src/evaluations/optimize/optimize.test.ts``."""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx

from acruxcore import AcruxCore


def make_client(handler: Any) -> AcruxCore:
    return AcruxCore(
        api_key="test-key",
        base_url="http://localhost:3000/api/v1",
        transport=httpx.MockTransport(handler),
        retry_interval=1,
    )


def recorder(bodies: List[Dict[str, Any]]) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(202, json={"run_id": "run-1", "status": "queued"})

    return handler


async def test_start_sends_judge_prompt_id():
    bodies: List[Dict[str, Any]] = []
    async with make_client(recorder(bodies)) as hub:
        await hub.optimize.start(
            "prompt-1", "ds-1", ["gpt-4o-mini"], judge_model="gpt-4o-mini", judge_prompt_id="judge-1"
        )

    assert bodies == [
        {"dataset_id": "ds-1", "models": ["gpt-4o-mini"], "judge_model": "gpt-4o-mini", "judge_prompt_id": "judge-1"}
    ]


async def test_start_leaves_judge_prompt_id_out_by_default():
    bodies: List[Dict[str, Any]] = []
    async with make_client(recorder(bodies)) as hub:
        await hub.optimize.start("prompt-1", "ds-1", ["gpt-4o-mini"], judge_model="gpt-4o-mini")

    assert "judge_prompt_id" not in bodies[0]
