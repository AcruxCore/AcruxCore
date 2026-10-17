"""Leg 2 of 2: run the same get_weather agent through AcruxCore.

Compared to the LangSmith leg, three things are not in this file:

1. The tool. It is a version in the Tool Catalog with an `http` executor, so the
   platform makes the request to wttr.in and trims the reply.
2. The prompt and the model. They are a version of the `weather-advisor` prompt, and
   the tool is bound to that prompt. `setup_acruxcore.py` creates all three once.
3. The tracing. The gateway writes the `llm` spans and the platform writes the `tool`
   span. The SDK puts them in one trace.

What is left is a render and one call.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/setup_acruxcore.py   # once
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/tool_agent_acruxcore.py

Needs: pip install acruxcore
"""

import asyncio
import json
import os
import sys

from acruxcore import AcruxCore

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        # One render returns the messages, the bound model, the bound tools and the
        # prompt version id. run_prompt_with_tools reads all of them from it.
        rendered = await hub.prompts.render("weather-advisor", "production", {"city": "Lahore"})
        result = await hub.gateway.run_prompt_with_tools(
            rendered, trace={"name": "weather-tool-agent"}
        )

    print(json.dumps({"answer": result.content, "iterations": result.iterations,
                      "trace_id": result.trace_id}, indent=2))
    print(f"\nAcruxCore trace: {BASE_URL.replace('/api/v1', '')}/traces/{result.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
