"""SDK leg: the same get_weather agent using the `acruxcore` Python SDK.

This is the third way to write the run, after the raw-REST/OpenAI-client legs.
`run_tool_loop` owns the entire loop — call the model, run the tool calls, append
results, repeat — and reports one trace covering all of it. Three things disappear
compared to `tool_agent_acruxcore.py`:

* No registration step: `@acrux.tool` is the tool definition, and the loop
  reconciles it with the catalog on its first call. Re-running with an unchanged
  function commits nothing.
* No tool schema is assembled: the derived schema is what the catalog holds, and
  the gateway serves the model that same version.
* No trace plumbing: no trace id to mint, no headers to set, no parent span to
  thread. The gateway writes the `llm` spans, the SDK writes the `tool` spans.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  python examples/tool_agent_acruxcore_sdk.py

Needs: pip install acruxcore
"""

import asyncio
import json
import os
import sys
from typing import Any

from acruxcore import AcruxCore, acrux

from weather_tool_shared import MODEL_ACRUXCORE, build_messages, get_weather

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
TRACE_NAME = "weather-tool-agent-sdk"

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


# A distinct name from the `http`-executor `get_weather`: this loop runs the tool in
# this process, so its version declares a `client` executor. Registering both under
# one name would mean one of them lying about who runs the tool. The decorator takes
# the name from the function, so the distinction lives in the function name.
@acrux.tool
def get_weather_local(city: str) -> dict[str, Any]:
    """Get the current weather for a city.

    Returns temperature in Celsius, what it feels like, a text condition, and humidity.

    Args:
        city: City name, e.g. 'Lahore' or 'Berlin'.
    """
    return get_weather(city)


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as client:
        result = await client.run_tool_loop(
            model=MODEL_ACRUXCORE,
            messages=build_messages(),
            # One argument replaces the register-then-reference dance: the loop syncs
            # this tool, then names it to the gateway as a catalog ref.
            tools=[get_weather_local],
            trace={"name": TRACE_NAME},
        )

    print(
        json.dumps(
            {
                "answer": result.content,
                "iterations": result.iterations,
                "stopped_at_limit": result.stopped_at_limit,
                "trace_id": result.trace_id,
            },
            indent=2,
        )
    )
    print(f"\nAcrux Core trace: {BASE_URL.replace('/api/v1', '')}/traces/{result.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
