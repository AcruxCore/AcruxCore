"""
Create the four supervisor tools in the AcruxCore catalog via @acrux.tool + tools.sync().

Run once before supervisor_flow.py.  Requires:
  pip install acruxcore langchain_community tavily-python yfinance
"""
import asyncio
from datetime import datetime
from typing import Optional, cast, Any

from acruxcore import AcruxCore, acrux
from langchain_community.tools.tavily_search import TavilySearchResults
from langchain_community.tools.yahoo_finance_news import YahooFinanceNewsTool


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


async def main() -> None:
    async with AcruxCore() as hub:
        results = await hub.tools.sync(
            [finance_research, advanced_research, basic_research, get_todays_date]
        )
        for fn, r in zip([finance_research, advanced_research, basic_research, get_todays_date], results):
            print(f"{fn.__name__}: tool_id={r.tool_id} v{r.version_number} committed={r.committed}")


if __name__ == "__main__":
    asyncio.run(main())
