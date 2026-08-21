"""
Path B — the definition lives in the catalog.

Nothing here defines a tool. The schema, the description, the executor and the
version all come from the platform; this file supplies one function body and a
map that says which catalog tool it implements.

Define the tool first, either in the dashboard or with setup_catalog_tool.py.

Run:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python catalog_defined_tool.py
"""

import asyncio
import json

from acruxcore import AcruxCore

TOOL_NAME = "get_weather_catalog"
PROMPT_NAME = "weather-brief-catalog"


def get_weather(city: str) -> dict:
    """Implementation only. The model never reads this docstring — the description
    it reads is the one stored on the catalog version."""
    print(f"  -> get_weather(city={city!r})")
    return {"city": city, "temp_c": 34, "sky": "hazy sun"}


#: Keyed by the CATALOG tool name, which need not match the function's name. The
#: function is called with the schema's own parameter names as keywords, so this
#: one has to accept `city=`.
CLIENT_TOOLS = {TOOL_NAME: get_weather}


async def main() -> None:
    async with AcruxCore() as hub:
        # Not needed to run — printed only to show where the definition comes from.
        resolved = (await hub.tools.resolve([{"name": TOOL_NAME, "version": 1}]))[0]
        print("definition, read from the catalog:")
        print(json.dumps(resolved.function, indent=2))
        print(f"  executor: {resolved.executor_type}   version: v{resolved.version_number}\n")

        rendered = await hub.prompts.render(PROMPT_NAME, "production")
        print(f"tools bound to this prompt: {[t['function']['name'] for t in rendered.tools]}\n")

        run = await hub.gateway.run_prompt_with_tools(
            rendered,
            messages=[
                *rendered.messages,
                {"role": "user", "content": "What is the weather in Karachi?"},
            ],
            client_tools=CLIENT_TOOLS,
            trace={"name": "catalog-defined-tool"},
        )
        print(f"answer: {run.content}")
        print(f"trace:  {run.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
