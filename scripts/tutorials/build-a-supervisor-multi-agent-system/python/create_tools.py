"""
Create the four supervisor tools in the AcruxCore catalog via @acrux.tool + tools.sync().

Run once before supervisor_flow.py.  Requires:
  pip install acruxcore tavily-python requests
"""
import asyncio
from datetime import datetime
from typing import Optional, cast, Any

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


async def main() -> None:
    async with AcruxCore() as hub:
        results = await hub.tools.sync(
            [finance_research, advanced_research, basic_research, get_todays_date]
        )
        for fn, r in zip([finance_research, advanced_research, basic_research, get_todays_date], results):
            print(f"{fn.__name__}: tool_id={r.tool_id} v{r.version_number} committed={r.committed}")


if __name__ == "__main__":
    asyncio.run(main())
