"""traces.list sends the failure, tag and metadata filters GET /traces takes (issue #464)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

import httpx

from acruxcore import AcruxCore

from conftest import signup_and_mint_key


async def test_list_traces_sends_failure_tag_and_metadata_filters() -> None:
    queries: List[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        queries.append(httpx.QueryParams(request.url.query.decode()).multi_items())
        return httpx.Response(200, json={"data": [], "total": 0, "page": 1, "limit": 20})

    async with AcruxCore(api_key="k", base_url="http://localhost:3000/api/v1",
                         transport=httpx.MockTransport(handler), max_retries=0) as hub:
        await hub.traces.list(
            error_type="tool_declared",
            error_code="location_not_found",
            has_warning=False,
            tags=["prod", "nl"],
            metadata={"region": "eu", "tier": "pro"},
        )

    # has_warning=False is a real filter (runs with no warning), so it must be sent.
    assert sorted(queries[0]) == sorted([
        ("error_type", "tool_declared"),
        ("error_code", "location_not_found"),
        ("has_warning", "false"),
        ("tags", "prod"),
        ("tags", "nl"),
        ("metadata[region]", "eu"),
        ("metadata[tier]", "pro"),
    ])


async def test_list_traces_filters_narrow_real_traces(api_server: str) -> None:
    """The same filters against the real API: each one keeps the trace it names."""
    key = await signup_and_mint_key(api_server)
    now = datetime.now(timezone.utc).isoformat()
    run = uuid.uuid4().hex[:8]

    def span(span_id: str, attributes: Dict[str, Any]) -> Dict[str, Any]:
        return {"spanId": span_id, "name": "lookup", "kind": "tool", "status": "ok",
                "startTime": now, "endTime": now, "attributes": attributes}

    async with AcruxCore(api_key=key, base_url=api_server, max_retries=0) as hub:
        declared = await hub.traces.ingest({
            "name": "declared", "tags": [f"t-{run}", "prod"], "metadata": {"region": "eu"},
            "spans": [span("d1", {"errorType": "tool_declared", "errorCode": f"no_city_{run}"})],
        })
        warned = await hub.traces.ingest({
            "name": "warned", "tags": [f"t-{run}"], "metadata": {"region": "us"},
            "spans": [span("w1", {"warning": {"type": "schema_mismatch", "message": "extra field"}})],
        })

        async def ids(**filters: Any) -> List[str]:
            filters.setdefault("tags", [f"t-{run}"])
            page = await hub.traces.list(**filters)
            return sorted(t.id for t in page.data)

        assert await ids() == sorted([declared.trace_id, warned.trace_id])
        assert await ids(tags=[f"t-{run}", "prod"]) == [declared.trace_id]
        assert await ids(metadata={"region": "us"}) == [warned.trace_id]
        assert await ids(error_type="tool_declared") == [declared.trace_id]
        assert await ids(error_code=f"no_city_{run}") == [declared.trace_id]
        assert await ids(has_warning=True) == [warned.trace_id]
        assert await ids(has_warning=False) == [declared.trace_id]


async def test_a_single_tag_string_is_one_tag_not_one_per_letter() -> None:
    # A str is itself a Sequence[str], so the type checker lets tags="prod" through.
    # Iterated as given, it sent tags=p&tags=r&tags=o&tags=d and matched nothing.
    queries: List[list] = []

    def handler(request: httpx.Request) -> httpx.Response:
        queries.append(httpx.QueryParams(request.url.query.decode()).multi_items())
        return httpx.Response(200, json={"data": [], "total": 0, "page": 1, "limit": 20})

    async with AcruxCore(api_key="k", base_url="http://localhost:3000/api/v1",
                         transport=httpx.MockTransport(handler), max_retries=0) as hub:
        await hub.traces.list(tags="prod")

    assert queries[0] == [("tags", "prod")]
