"""Issue #452 — a client-side tool that knows it failed must be able to say so.

Every test drives the real client through a mocked httpx transport and then reads the
``tool`` spans the SDK actually POSTs to ``/traces``, because the bug being fixed was
precisely that the loop looked fine while the recorded span lied.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore, ToolResult

pytestmark = pytest.mark.asyncio


TOOL_CALL_ROUND: Dict[str, Any] = {
    "id": "chatcmpl-1",
    "model": "gpt-4o-mini",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city":"Atlantis"}'},
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }
    ],
}

FINAL_ROUND: Dict[str, Any] = {
    "id": "chatcmpl-2",
    "model": "gpt-4o-mini",
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "No data."}, "finish_reason": "stop"}
    ],
}


def resolved(**extra: Any) -> Dict[str, Any]:
    """The `/tools/resolve` payload for one client-executor tool."""
    return {
        "data": [
            {
                "toolId": "tool-1",
                "versionNumber": 4,
                "executorType": "client",
                "function": {"name": "get_weather", "parameters": {"type": "object"}},
                **extra,
            }
        ]
    }


def make_client(
    sent: List[httpx.Request], *, resolve_payload: Dict[str, Any] | None = None,
    fail_second_round: bool = False,
) -> AcruxCore:
    """A client whose transport serves resolve → tool-call round → final round."""
    rounds = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        path = request.url.path
        if path.endswith("/tools/resolve"):
            return httpx.Response(200, json=resolve_payload or resolved())
        if path.endswith("/chat/completions"):
            rounds["n"] += 1
            if rounds["n"] == 1:
                return httpx.Response(
                    200, json=TOOL_CALL_ROUND, headers={"x-gateway-trace-id": "tr-1"}
                )
            if fail_second_round:
                return httpx.Response(
                    502, json={"error": {"code": "PROVIDER_ERROR", "message": "upstream exploded"}}
                )
            return httpx.Response(200, json=FINAL_ROUND)
        return httpx.Response(200, json={"traceIds": ["tr-1"]})

    return AcruxCore(
        api_key="k",
        base_url="http://localhost:3001/api/v1",
        transport=httpx.MockTransport(handler),
    )


def tool_spans(sent: List[httpx.Request]) -> List[Dict[str, Any]]:
    """Every ``tool`` span the SDK reported, across all `/traces` posts."""
    out: List[Dict[str, Any]] = []
    for request in sent:
        if not request.url.path.endswith("/traces"):
            continue
        body = json.loads(request.content.decode("utf-8"))
        for trace in body.get("traces", []):
            out.extend(s for s in trace.get("spans", []) if s.get("kind") == "tool")
    return out


async def run_loop(client: AcruxCore, fn: Callable[..., Any]) -> Any:
    return await client.gateway.run_tool_loop(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Weather in Atlantis?"}],
        tool_refs=[{"name": "get_weather"}],
        client_tools={"get_weather": fn},
    )


async def test_tool_result_error_turns_the_span_red_without_stopping_the_loop() -> None:
    sent: List[httpx.Request] = []
    client = make_client(sent)
    async with client:
        result = await run_loop(
            client,
            lambda city: ToolResult.error(
                "location_not_found", "No weather data for Atlantis", result={"error": "not found"}
            ),
        )
        await client.gateway.flush()

    # Declaring a failure does NOT stop the loop — that stays the caller's decision.
    assert result.content == "No data."

    spans = tool_spans(sent)
    assert len(spans) == 1
    assert spans[0]["status"] == "error"
    assert spans[0]["error"] == "No weather data for Atlantis"
    assert spans[0]["output"] == {"error": "not found"}
    assert spans[0]["attributes"]["errorType"] == "tool_declared"
    # The slug the tool chose, kept as its own attribute so it can be matched on.
    # `errorType` says which classifier fired; `errorCode` says what the tool called it.
    assert spans[0]["attributes"]["errorCode"] == "location_not_found"

    # The model reads the `result`, not the sentinel wrapper.
    second = [r for r in sent if r.url.path.endswith("/chat/completions")][1]
    messages = json.loads(second.content.decode("utf-8"))["messages"]
    assert messages[-1]["content"] == json.dumps({"error": "not found"})


async def test_tool_result_warn_leaves_the_span_green() -> None:
    sent: List[httpx.Request] = []
    client = make_client(sent)
    async with client:
        await run_loop(
            client,
            lambda city: ToolResult.warn("stale_data", "cache is 6h old", result={"tempC": 18}),
        )
        await client.gateway.flush()

    span = tool_spans(sent)[0]
    # A warning is not a verdict about whether the run succeeded.
    assert span["status"] == "ok"
    assert "error" not in span
    assert span["attributes"]["errorCode"] == "stale_data"
    assert span["attributes"]["warning"] == {"type": "stale_data", "message": "cache is 6h old"}
    assert span["output"] == {"tempC": 18}


async def test_client_tool_is_checked_against_the_catalog_result_schema() -> None:
    sent: List[httpx.Request] = []
    client = make_client(
        sent,
        resolve_payload=resolved(
            resultSchema={
                "type": "object",
                "properties": {"tempC": {"type": "number"}},
                "required": ["tempC"],
            }
        ),
    )
    async with client:
        await run_loop(client, lambda city: {"tempC": "quite warm"})
        await client.gateway.flush()

    span = tool_spans(sent)[0]
    # Warn by default: our own declaration may be the wrong one, and a check that cries
    # wolf gets switched off, taking the real signal with it.
    assert span["status"] == "ok"
    assert span["attributes"]["errorType"] == "schema_mismatch"
    assert span["attributes"]["warning"]["type"] == "schema_mismatch"


async def test_result_schema_mismatch_is_an_error_when_the_catalog_says_so() -> None:
    sent: List[httpx.Request] = []
    client = make_client(
        sent,
        resolve_payload=resolved(
            resultSchema={"type": "object", "required": ["tempC"]},
            resultSchemaSeverity="error",
        ),
    )
    async with client:
        await run_loop(client, lambda city: {"humidity": 40})
        await client.gateway.flush()

    span = tool_spans(sent)[0]
    assert span["status"] == "error"
    assert span["attributes"]["errorType"] == "schema_mismatch"


async def test_a_plain_return_value_is_untouched() -> None:
    sent: List[httpx.Request] = []
    client = make_client(sent)
    async with client:
        await run_loop(client, lambda city: {"tempC": 18})
        await client.gateway.flush()

    span = tool_spans(sent)[0]
    assert span["status"] == "ok"
    assert span["output"] == {"tempC": 18}
    assert "errorType" not in span["attributes"]
    assert "warning" not in span["attributes"]


async def test_tool_spans_survive_a_round_that_raises() -> None:
    # Before the try/finally, a round that raised discarded every tool span the run had
    # already produced, and the trace showed a run that called no tools at all.
    sent: List[httpx.Request] = []
    client = make_client(sent, fail_second_round=True)
    async with client:
        with pytest.raises(Exception):
            await run_loop(client, lambda city: {"tempC": 18})
        await client.gateway.flush()

    spans = tool_spans(sent)
    assert len(spans) == 1
    assert spans[0]["name"] == "get_weather"
    assert spans[0]["status"] == "ok"
