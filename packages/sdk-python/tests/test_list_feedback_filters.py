"""list_feedback narrows the feed with the filters GET /traces/feedback takes."""

from __future__ import annotations

from typing import List
from urllib.parse import parse_qs

import httpx

from acruxcore import AcruxCore


async def test_list_feedback_sends_rating_and_prompt_filters() -> None:
    queries: List[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        queries.append(parse_qs(request.url.query.decode()))
        return httpx.Response(200, json={"data": [], "total": 0, "page": 2, "limit": 100})

    async with AcruxCore(api_key="k", base_url="http://localhost:3000/api/v1",
                         transport=httpx.MockTransport(handler), max_retries=0) as hub:
        await hub.traces.list_feedback(page=2, limit=100, rating="down", prompt_id="p-1")
        await hub.traces.list_feedback()

    assert queries[0] == {"page": ["2"], "limit": ["100"], "rating": ["down"], "prompt_id": ["p-1"]}
    assert queries[1] == {}
