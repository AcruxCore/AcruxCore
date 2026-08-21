"""
Stream a prompt's tools -- Python, standalone.

The whole point of the streaming tool loop in one file: text arrives token by
token, and a running tool is its own event rather than more model text. The timings
printed at the end show what that bought you -- the answer starts appearing a few
hundred milliseconds after the tool returns, instead of when the loop ends.

Expects a prompt whose alias has a tool bound to it. The defaults match the
`weather-brief` / `get_weather` pair from the "Connect a tool to a prompt" guide:

  * `production` binds `get_weather` at its `production` alias, whose version has
    an `http` executor -- the platform runs it, so CLIENT_TOOLS below is never used.
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
  python stream_prompt_tools.py
  PROMPT_ALIAS=staging CITY=Karachi python stream_prompt_tools.py
"""
import asyncio
import os
import sys
import time
from typing import Optional

from acruxcore import AcruxCore, AcruxCoreError

PROMPT_NAME = os.environ.get("PROMPT_NAME", "weather-brief")
PROMPT_ALIAS = os.environ.get("PROMPT_ALIAS", "production")
CITY = os.environ.get("CITY", "Lisbon")


def get_weather(city: str) -> dict:
    """A stand-in for a real weather call, so the script needs no third-party key."""
    return {"location": city, "tempC": 21, "condition": "Sunny"}


#: The tools this script runs itself, keyed by catalog tool name.
#:
#: `client_tools=` rather than `tools=[fn]` on purpose. A decorated function passed in
#: `tools=` is SYNCED to the catalog on first use, which commits a new version of a tool
#: of that name and moves its alias — so this script would quietly rewrite the tool it is
#: calling. `client_tools` writes nothing, keeps the binding's alias or pin, and is never
#: reached for an `http` executor, which the platform runs.
CLIENT_TOOLS = {"get_weather": get_weather}


async def main() -> None:
    async with AcruxCore() as hub:
        # One render. It carries the templated messages, the version's bound model, the
        # tools bound to this prompt alias, and the version id for trace lineage — which
        # is why the call below needs no arguments of its own.
        rendered = await hub.prompts.render(PROMPT_NAME, PROMPT_ALIAS, {"city": CITY})

        tools = ", ".join(
            f"{t.name}@{t.alias}" if t.alias else f"{t.name} v{t.pinned_version_number}"
            for t in rendered.tool_resolutions
        )
        print(f"prompt   {PROMPT_NAME}@{PROMPT_ALIAS}  (version {rendered.version_number})")
        print(f"model    {rendered.model}")
        print(f"tools    {tools or 'none bound'}")
        print("─" * 72)

        started = time.monotonic()
        first_event_at: Optional[float] = None
        first_text_at: Optional[float] = None
        last_tool_at: Optional[float] = None
        trace_id: Optional[str] = None

        try:
            # If every bound tool has an `http` executor — the default `production`
            # alias here — the platform runs them and this is the whole call:
            #
            #     stream = await hub.gateway.run_prompt_with_tools(rendered, stream=True)
            #
            # `client_tools=` is passed only so `PROMPT_ALIAS=staging` works too: that
            # alias binds a `client`-executor version, whose code lives in THIS file.
            stream = await hub.gateway.run_prompt_with_tools(
                rendered, stream=True, client_tools=CLIENT_TOOLS
            )
        except AcruxCoreError as err:
            # The most likely one here: the prompt version has no bound model, and the
            # message names both fixes.
            print(f"\n{err}", file=sys.stderr)
            raise SystemExit(1)

        async for event in stream:
            if first_event_at is None:
                first_event_at = time.monotonic()

            if event.type == "content":
                if first_text_at is None:
                    first_text_at = time.monotonic()
                # No newline, no buffering — this is what "streaming" has to look like.
                print(event.delta, end="", flush=True)

            elif event.type == "tool_call":
                print(f"\n  ⚙  calling {event.name}({event.arguments}) …", flush=True)

            elif event.type == "tool_result":
                last_tool_at = time.monotonic()
                if event.error:
                    print(f"  ✗  {event.name} failed: {event.error}", flush=True)
                else:
                    print(f"  ✓  {event.name} → {event.result}\n", flush=True)

            elif event.type == "done":
                trace_id = event.result.trace_id
                print("\n" + "─" * 72)
                print(f"rounds   {event.result.iterations}")
                if event.result.stopped_at_limit:
                    print("         (stopped at max_iterations — the model was still calling tools)")
                print(f"trace    {trace_id}")

        # What these numbers do and do not show. A tool round runs before the answer
        # exists at all, so "first token" being late is the loop, not the streaming —
        # the number that shows what streaming bought you is the last one: how long
        # after the tool finished the first word of the answer appeared. Unstreamed,
        # you would have waited for `total` before seeing anything.
        end = time.monotonic()
        if first_event_at is not None:
            print(f"first event                 {(first_event_at - started) * 1000:7.0f} ms  (a tool call, or text)")
        if first_text_at is not None:
            print(f"first token of the answer   {(first_text_at - started) * 1000:7.0f} ms")
        if first_text_at is not None and last_tool_at is not None:
            print(f"  … after the last tool      {(first_text_at - last_tool_at) * 1000:7.0f} ms")
        print(f"whole loop                  {(end - started) * 1000:7.0f} ms")

        # The loop reports its trace in the background; wait for that write so the
        # trace is readable the moment this script exits.
        await hub.gateway.flush()
        print("\nOpen the trace to see one llm span per round with the tool span nested")
        print("under it — a streamed loop records exactly what a blocking one does.")


if __name__ == "__main__":
    asyncio.run(main())
