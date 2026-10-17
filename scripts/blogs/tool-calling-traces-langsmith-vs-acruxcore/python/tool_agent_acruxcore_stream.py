"""Streaming variant of the AcruxCore leg.

The same render and the same call as `tool_agent_acruxcore.py`, with `stream=True`.
The SDK assembles the streamed tool call, runs the tool and starts the next round.
The caller receives typed events: `content`, `tool_call`, `tool_result` and `done`.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/setup_acruxcore.py   # once
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/tool_agent_acruxcore_stream.py

Needs: pip install acruxcore
"""

import asyncio
import os
import sys

from acruxcore import AcruxCore

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        rendered = await hub.prompts.render("weather-advisor", "production", {"city": "Lahore"})
        events = await hub.gateway.run_prompt_with_tools(
            rendered, stream=True, trace={"name": "weather-tool-agent-stream"}
        )
        async for event in events:
            if event.type == "content":
                print(event.delta, end="", flush=True)
            elif event.type == "tool_call":
                print(f"[calling {event.name}({event.arguments})]")
            elif event.type == "tool_result":
                print(f"[{event.name} returned {event.result}]")
            elif event.type == "done":
                trace_id = event.result.trace_id

    print(f"\n\nAcruxCore trace: {BASE_URL.replace('/api/v1', '')}/traces/{trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
