"""
Supervisor multi-agent flow -- Python, over the gateway.

Step A: render the router prompt (content-supervisor) and call the gateway with
        response_format set to a typed { "route_to": ... } json_schema.
Step B: render the matching subagent's prompt + tools and run run_tool_loop(),
        passing trace={"trace_id": ...} so both calls land in ONE trace.

Requires:
  pip install acruxcore langchain_community tavily-python yfinance requests
"""
import asyncio, json, os, sys
from datetime import datetime
from typing import Any, Optional, cast

import requests
from acruxcore import AcruxCore, acrux
from langchain_community.tools.tavily_search import TavilySearchResults
from langchain_community.tools.yahoo_finance_news import YahooFinanceNewsTool

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
    wrapped = YahooFinanceNewsTool()
    return cast(Any, await wrapped.ainvoke({"query": ticker_symbol}))


@acrux.tool
async def advanced_research(query: str) -> Optional[list]:
    """Perform in-depth research with more results and deeper analysis. This tool
    will return 10 results and go deeper for more information.

    Args:
        query (str): The query to search for.
    """
    wrapped = TavilySearchResults(max_results=10, search_depth="advanced")
    return cast(Any, await wrapped.ainvoke({"query": query}))


@acrux.tool
async def basic_research(query: str) -> Optional[list]:
    """This tool performs quick searches with little depth,
    returning concise results ideal for basic research or quick queries.

    Args:
        query (str): The query to search for.
    """
    wrapped = TavilySearchResults(max_results=5, search_depth="basic", include_raw_content=False, include_images=True)
    return cast(Any, await wrapped.ainvoke({"query": f"trending {query}"}))


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
