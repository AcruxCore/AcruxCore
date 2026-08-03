"""
Configurable web-research agent — Python, the async SDK's run_tool_loop(), over
the gateway. The whole configuration swap is which alias you render: "quick" binds
a cheap, fast model and a shallow Tavily search; "deep" binds a bigger model and an
advanced, wider search. No code below changes between the two runs.

Flow:
  1. render        — hub.render_prompt("web-research-agent", ALIAS, {...}) ->
                      messages, tools, model, versionId. All four come from
                      whichever ALIAS you pass in.
  2. run_tool_loop  — drives the gateway completion loop for you, threading one
                      trace. web_research is a CLIENT tool (the catalog stores only
                      its schema), so we pass it as tool_defs + dispatch.
  3. dispatch       — calls the exact source's TavilySearchResults wrapper
                      directly (no REST reimplementation), with max_results/
                      search_depth/include_images chosen by ALIAS — mirroring the
                      source's advanced_research (10, advanced) vs basic_research
                      (5, basic, images, "trending " prefix).

Run:
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  export TAVILY_API_KEY=tvly-...
  python run_agent.py quick "What are people saying about the new Anthropic Claude models?"
  python run_agent.py deep  "What are people saying about the new Anthropic Claude models?"
"""

import asyncio
import sys

from acruxcore import AcruxCore
from langchain_community.tools.tavily_search import TavilySearchResults

PROMPT = "web-research-agent"


async def web_research(query: str, alias: str) -> list:
    """Real call to the source's own TavilySearchResults wrapper — not a
    hand-rolled REST substitute. Depth is picked by ALIAS, not by the model:
    the model only ever supplies `query`."""
    if alias == "quick":
        # basic_research: 5 results, basic depth, images, "trending" framing
        wrapped = TavilySearchResults(
            max_results=5, search_depth="basic", include_raw_content=False, include_images=True
        )
        results = await wrapped.ainvoke({"query": f"trending {query}"})
    else:
        # advanced_research: 10 results, advanced depth
        wrapped = TavilySearchResults(max_results=10, search_depth="advanced")
        results = await wrapped.ainvoke({"query": query})
    return [{"title": item["title"], "url": item["url"]} for item in results]


async def dispatch(name: str, args: dict, alias: str):
    """Route a tool call from the model to its local implementation."""
    if name == "web_research":
        results = await web_research(args["query"], alias)
        print(f"  -> web_research({args}) -> {len(results)} result(s)")
        return results
    raise ValueError(f"Unknown tool: {name}")


async def ask(hub: AcruxCore, alias: str, question: str) -> None:
    rendered = await hub.render_prompt(PROMPT, alias, {"question": question})
    print(f"Alias: {alias} -> model {rendered.model}")
    print(f"Question: {question}\n")

    result = await hub.run_tool_loop(
        rendered.model,  # bound to the prompt version in the dashboard, per alias
        [*rendered.messages],
        tool_defs=rendered.tools,
        dispatch=lambda name, args: dispatch(name, args, alias),
        prompt_version_id=rendered.version_id,
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
