"""
Configurable web-research agent — Python, the async SDK's run_tool_loop(), over
the gateway. The whole configuration swap is which alias you render: "quick" binds
a cheap, fast model and a shallow Tavily search; "deep" binds a bigger model and an
advanced, wider search. No code below changes between the two runs.

Flow:
  1. render        — hub.prompts.render("web-research-agent", ALIAS, {...}) ->
                      messages, tools, model, versionId. All four come from
                      whichever ALIAS you pass in.
  2. run_prompt_with_tools — drives the gateway completion loop for you, threading
                      one trace. web_research is a CLIENT tool (the catalog stores
                      only its schema), so its implementation goes in client_tools.
  3. client_tools  — calls Tavily through its own maintained SDK, with
                      max_results/search_depth/include_images chosen by ALIAS —
                      mirroring the source's advanced_research (10, advanced) vs
                      basic_research (5, basic, images, "trending " prefix).

Run:
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  export TAVILY_API_KEY=tvly-...
  python run_agent.py quick "What are people saying about the new Anthropic Claude models?"
  python run_agent.py deep  "What are people saying about the new Anthropic Claude models?"

Dependencies: pip install acruxcore tavily-python
"""

import asyncio
import sys

from acruxcore import AcruxCore
from tavily import AsyncTavilyClient

PROMPT = "web-research-agent"


async def web_research(query: str, alias: str) -> list:
    """A real Tavily search, through Tavily's own maintained SDK.

    Depth is picked by ALIAS, not by the model: the model only ever supplies
    `query`. That is the whole point of this tutorial — the same code answers
    differently because the prompt alias configured it differently.

    `AsyncTavilyClient` reads TAVILY_API_KEY from the environment, and its
    `search()` returns `{"query", "results", "images", ...}` — so the result
    list is one level in, unlike the langchain wrapper this replaced, which
    handed back the list directly.
    """
    client = AsyncTavilyClient()
    if alias == "quick":
        # basic_research: 5 results, basic depth, images, "trending" framing
        res = await client.search(
            f"trending {query}", max_results=5, search_depth="basic", include_images=True
        )
    else:
        # advanced_research: 10 results, advanced depth
        res = await client.search(query, max_results=10, search_depth="advanced")
    return [{"title": item["title"], "url": item["url"]} for item in res["results"]]


def client_tools_for(alias: str) -> dict:
    """The tools this script runs itself, keyed by catalog tool name.

    Built per alias rather than once, because the alias is what picks the search
    depth -- the model only ever supplies `query`. The closure is where the one piece
    of alias-dependent configuration lives.
    """

    async def run_web_research(query: str) -> list:
        results = await web_research(query, alias)
        print(f"  -> web_research({{'query': {query!r}}}) -> {len(results)} result(s)")
        return results

    return {"web_research": run_web_research}


async def ask(hub: AcruxCore, alias: str, question: str) -> None:
    rendered = await hub.prompts.render(PROMPT, alias, {"question": question})
    print(f"Alias: {alias} -> model {rendered.model}")
    print(f"Question: {question}\n")

    # The model, the messages, the bound tool and the version id for trace lineage all
    # come from the render, so only the tool's implementation is passed here.
    result = await hub.gateway.run_prompt_with_tools(
        rendered,
        client_tools=client_tools_for(alias),
        trace={"name": "web-research-agent", "session_id": f"web-research-{alias}"},
    )
    print(f"Assistant: {result.content}")
    print(f"\n({result.iterations} model turn(s), trace {result.trace_id})")


async def main() -> None:
    alias = sys.argv[1] if len(sys.argv) > 1 else "quick"
    question = sys.argv[2] if len(sys.argv) > 2 else (
        "What are people saying about the new Anthropic Claude models?"
    )
    async with AcruxCore() as hub:  # reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL
        await ask(hub, alias, question)


if __name__ == "__main__":
    asyncio.run(main())
