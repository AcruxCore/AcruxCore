"""
Supervisor multi-agent flow -- Python, over the gateway.

Step A: render the router prompt (content-supervisor) and call the gateway with
        response_format set to a typed { "route_to": ... } json_schema.
Step B: render the matching subagent's prompt + tools and run run_tool_loop(),
        passing trace={"trace_id": ...} so both calls land in ONE trace.

Requires:
  pip install acruxcore tavily-python requests
"""
import asyncio, json, os, sys
from datetime import datetime
from typing import Any, Optional, cast

import requests
from acruxcore import AcruxCore, acrux
from tavily import AsyncTavilyClient


#: Yahoo's own news-stream endpoint. Two calls in this order: a GET to fc.yahoo.com to
#: pick up a session cookie, then this POST, which needs it. Both need a browser-shaped
#: User-Agent. This is what langchain_community's YahooFinanceNewsTool did internally;
#: it is written out here because that package is being sunset upstream (issue #365).
YAHOO_NEWS_URL = "https://finance.yahoo.com/xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin"


def _yahoo_headlines(ticker_symbol: str, limit: int = 3) -> str:
    """Recent Yahoo Finance headlines for one ticker, as plain text for the model."""
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})
    session.get("https://fc.yahoo.com", timeout=15)
    res = session.post(
        YAHOO_NEWS_URL,
        json={"serviceConfig": {"snippetCount": limit, "s": [ticker_symbol]}},
        timeout=20,
    )
    res.raise_for_status()
    stream = res.json()["data"]["tickerStream"]["stream"]
    items = [
        f"{item['content']['title']}\n{item['content'].get('summary') or ''}".strip()
        for item in stream[:limit]
    ]
    return "\n\n".join(items) or f"No recent news found for {ticker_symbol}."


async def _tavily_search(query: str, *, max_results: int, search_depth: str,
                         include_images: bool = False) -> list:
    """One Tavily search through Tavily's own maintained SDK.

    `search()` answers `{"query", "results", "images", ...}`, so the result list is one
    level in — unlike the langchain wrapper this replaced, which returned it directly.
    """
    client = AsyncTavilyClient()
    res = await client.search(
        query, max_results=max_results, search_depth=search_depth,
        include_images=include_images,
    )
    return [{"title": r["title"], "url": r["url"]} for r in res["results"]]

ROUTER_PROMPT = "content-supervisor"
SUBAGENT_PROMPTS = {
    "finance_research_agent": "finance-research-agent",
    "general_research_agent": "general-research-agent",
    "writing_agent": "writing-agent",
}
ROUTE_SCHEMA = {
    "type": "object",
    "properties": {"route_to": {"type": "string", "enum": list(SUBAGENT_PROMPTS)}},
    "required": ["route_to"],
    "additionalProperties": False,
}

ACRUXCORE_API_KEY = os.environ["ACRUXCORE_API_KEY"]
ACRUXCORE_BASE_URL = os.environ["ACRUXCORE_BASE_URL"].rstrip("/")
ACRUXCORE_HEADERS = {"Authorization": f"Bearer {ACRUXCORE_API_KEY}", "Content-Type": "application/json"}


@acrux.tool
async def finance_research(ticker_symbol: str) -> Optional[list]:
    """Search for finance research, must be a ticker symbol. This tool is used to search for financial data and news from Yahoo Finance.
    It will return related finincial news from Yahoo Finance for that given ticker symbol.

    Args:
        ticker_symbol (str): The ticker symbol of the company to research.
    """
    return cast(Any, _yahoo_headlines(ticker_symbol))


@acrux.tool
async def advanced_research(query: str) -> Optional[list]:
    """Perform in-depth research with more results and deeper analysis. This tool
    will return 10 results and go deeper for more information.

    Args:
        query (str): The query to search for.
    """
    return cast(Any, await _tavily_search(query, max_results=10, search_depth="advanced"))


@acrux.tool
async def basic_research(query: str) -> Optional[list]:
    """This tool performs quick searches with little depth,
    returning concise results ideal for basic research or quick queries.

    Args:
        query (str): The query to search for.
    """
    return cast(
        Any,
        await _tavily_search(
            f"trending {query}", max_results=5, search_depth="basic", include_images=True
        ),
    )


@acrux.tool
async def get_todays_date() -> str:
    """Quick tool to get today's date.
    Args: None
    """
    return datetime.now().strftime("%Y-%m-%d")


TOOLS_BY_ROUTE = {
    "finance_research_agent": [finance_research, basic_research, get_todays_date],
    "general_research_agent": [advanced_research, get_todays_date],
    "writing_agent": [basic_research, get_todays_date],
}


async def main() -> None:
    question = sys.argv[1] if len(sys.argv) > 1 else (
        "Research Tesla (TSLA) latest stock news and tell me if investors should be worried."
    )

    async with AcruxCore() as hub:  # reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL
        rendered_router = await hub.prompts.render(ROUTER_PROMPT, "production", {"question": question})
        resp = requests.post(
            f"{ACRUXCORE_BASE_URL}/gateway/chat/completions",
            headers=ACRUXCORE_HEADERS,
            json={
                "model": rendered_router.model,
                "messages": rendered_router.messages,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "route_decision", "schema": ROUTE_SCHEMA, "strict": True},
                },
            },
        )
        resp.raise_for_status()
        route_to = json.loads(resp.json()["choices"][0]["message"]["content"])["route_to"]
        trace_id = resp.headers["x-gateway-trace-id"]

        print(f"Question: {question}")
        print(f"Step A -- routed to: {route_to}  (trace {trace_id})\n")

        subagent_prompt = SUBAGENT_PROMPTS[route_to]
        rendered_sub = await hub.prompts.render(subagent_prompt, "production", {"task": question})

        result = await hub.gateway.run_tool_loop(
            rendered_sub.model,
            [*rendered_sub.messages],
            tools=TOOLS_BY_ROUTE[route_to],
            sync=False,
            prompt_version_id=rendered_sub.version_id,
            trace={"trace_id": trace_id},
        )
        print(f"Step B -- {route_to}: {result.content}")
        print(f"\n({result.iterations} model turn(s), trace {result.trace_id})")


if __name__ == "__main__":
    asyncio.run(main())
