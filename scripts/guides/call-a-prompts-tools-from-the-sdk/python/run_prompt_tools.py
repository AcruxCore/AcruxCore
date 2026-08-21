"""
Call a prompt's tools from the SDK -- Python.

Runs the same prompt four ways, so the four calling shapes can be compared side
by side against one real prompt:

  1. run_prompt_with_tools(r)               -- the preferred way, two lines.
  2. run_prompt_with_tools(r, stream=True)  -- the same, as typed events.
  3. run_tool_loop(...) by hand             -- when the loop needs changing.
  4. chat(tool_refs=...)                    -- one request, nothing dispatched.

Expects a prompt whose alias has a tool bound to it. The defaults match the
`weather-brief` / `get_weather` pair from the "Connect a tool to a prompt" guide:

  * `production` binds `get_weather` at its `production` alias, whose version has
    an `http` executor -- the platform runs it, so no tool code is needed here.
  * `staging` binds the same tool at its `staging` alias, whose version has a
    `client` executor -- the function in THIS file runs it.

Requires:
  pip install acruxcore

Env:
  ACRUXCORE_API_KEY   -- required
  ACRUXCORE_BASE_URL  -- required, no default (e.g. http://localhost:3001/api/v1)
  PROMPT_NAME         -- default "weather-brief"
  PROMPT_ALIAS        -- default "production"
  CITY                -- default "Lisbon"

Run:
  python run_prompt_tools.py
  PROMPT_ALIAS=staging python run_prompt_tools.py
"""
import asyncio
import os

from acruxcore import AcruxCore

PROMPT_NAME = os.environ.get("PROMPT_NAME", "weather-brief")
PROMPT_ALIAS = os.environ.get("PROMPT_ALIAS", "production")
CITY = os.environ.get("CITY", "Lisbon")


def get_weather(city: str) -> dict:
    """A stand-in for a real weather call, so the script needs no third-party key."""
    return {"location": city, "tempC": 21, "condition": "Sunny"}


#: The tools this script runs itself, keyed by catalog tool name.
#:
#: `client_tools=` rather than `tools=[fn]` on purpose. A decorated function passed in
#: `tools=` is SYNCED to the catalog on first use, which commits a new version of a
#: tool of that name and moves its alias — so a script meant to demonstrate the calling
#: shapes would quietly rewrite the tool it is calling. `client_tools` writes nothing,
#: keeps the binding's alias or pin, and is never reached for an `http` executor, which
#: the platform runs.
CLIENT_TOOLS = {"get_weather": get_weather}


def section(number: str, title: str) -> None:
    print(f"\n{'=' * 64}\n{number}. {title}\n{'=' * 64}")


async def main() -> None:
    async with AcruxCore() as hub:
        # One render, reused by all four shapes below. `r` holds the templated
        # messages, the bound model, the resolved tool definitions, and which
        # binding decided each one.
        r = await hub.prompts.render(PROMPT_NAME, PROMPT_ALIAS, {"city": CITY})

        section("0", "What the render resolved")
        print("model         :", r.model)
        print("version       :", r.version_number, r.version_id)
        print("messages      :", r.messages)
        for res in r.tool_resolutions:
            pinned = f"pinned v{res.pinned_version_number}" if res.pinned_version_number else f"alias '{res.alias}'"
            print(f"tool          : {res.name} -> {pinned}, ran v{res.version_number} (decided by {res.source})")

        # 1. The preferred way -------------------------------------------------
        # Model, messages, tools and trace lineage all come from the render.
        section("1", "run_prompt_with_tools(r)")
        result = await hub.gateway.run_prompt_with_tools(r, client_tools=CLIENT_TOOLS)
        print("answer        :", result.content)
        print("iterations    :", result.iterations)
        print("trace         :", result.trace_id)

        # 2. The same call, streamed ------------------------------------------
        # A discriminated event stream, so "a tool is running" is its own state
        # rather than more model text.
        section("2", "run_prompt_with_tools(r, stream=True)")
        async for event in await hub.gateway.run_prompt_with_tools(
            r, stream=True, client_tools=CLIENT_TOOLS
        ):
            if event.type == "content":
                print(event.delta, end="", flush=True)
            elif event.type == "tool_call":
                print(f"\n[calling {event.name}({event.arguments})]")
            elif event.type == "tool_result":
                print(f"[{event.name} -> {event.result}]")
            elif event.type == "done":
                print(f"\ntrace         : {event.result.trace_id}")

        # 3. By hand, when the loop needs changing -----------------------------
        # Everything run_prompt_with_tools fills in, spelled out. Reach for this
        # to pass a subset of the bound tools, an extra tool that is not bound,
        # a different max_iterations, or a response_format.
        section("3", "run_tool_loop(...) by hand")
        by_hand = await hub.gateway.run_tool_loop(
            r.model,
            r.messages,
            client_tools=CLIENT_TOOLS,
            tool_refs=[{"name": t.name, "alias": t.alias} for t in r.tool_resolutions],
            prompt_version_id=r.version_id,
            max_iterations=3,
        )
        print("answer        :", by_hand.content)

        # 4. One request, one completion ---------------------------------------
        # `tool_calls` come back raw and nothing is dispatched -- for when you own
        # the loop, or want to inspect the call before running anything.
        section("4", "chat(tool_refs=...) -- nothing dispatched")
        once = await hub.gateway.chat(
            r.model,
            r.messages,
            tool_refs=[{"name": t.name, "alias": t.alias} for t in r.tool_resolutions],
            prompt_version_id=r.version_id,
        )
        print("finish_reason :", once.finish_reason)
        print("tool_calls    :", once.message.get("tool_calls"))

        await hub.gateway.flush()


if __name__ == "__main__":
    asyncio.run(main())
