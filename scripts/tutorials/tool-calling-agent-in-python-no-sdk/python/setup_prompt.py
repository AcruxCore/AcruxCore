"""
Create the `get_weather` tool and the `py-weather-agent` prompt, and connect
them — the Python SDK half of Step 4 of the tutorial.

This is the runnable version of the page's "Python (SDK)" tab. The rest of that
tutorial deliberately uses plain `requests` with no SDK; this one setup step is
the exception, because the page offers an SDK tab for it alongside curl.

Run it before weather_agent.py. Find-or-create throughout, so a second run is a
no-op rather than a `TOOL_NAME_TAKEN` / `PROMPT_NAME_TAKEN` error.

Run:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python setup_prompt.py
"""

import asyncio
from typing import Any, List

from acruxcore import AcruxCore

TOOL_NAME = "get_weather"
PROMPT_NAME = "py-weather-agent"


async def page(hub: AcruxCore, path: str) -> List[Any]:
    """Every row of a paginated list endpoint (the API caps `limit` at 100)."""
    rows: List[Any] = []
    n = 1
    while True:
        res = await hub._request("GET", f"{path}?limit=100&page={n}", None, f"listing {path}")
        body = res.json()
        rows += body.get("data", [])
        if len(rows) >= body.get("total", len(rows)) or not body.get("data"):
            return rows
        n += 1


async def main() -> None:
    async with AcruxCore() as hub:
        tools = {t["name"]: t["id"] for t in await page(hub, "/tools")}
        prompts = {p["name"]: p["id"] for p in await page(hub, "/prompts")}

        if TOOL_NAME in tools:
            tool_id = tools[TOOL_NAME]
            print(f"  = tool {TOOL_NAME} already in the catalog")
        else:
            tool = await hub.tools.create(
                name=TOOL_NAME,
                description="Get the current weather for a city.",
            )
            await hub.tools.commit_version(
                tool.id,
                parameters_schema={
                    "type": "object",
                    "properties": {"city": {"type": "string", "description": 'City name, e.g. "Tokyo".'}},
                    "required": ["city"],
                },
                executor={"type": "client"},
            )
            tool_id = tool.id
            print(f"  + created tool {TOOL_NAME}")

        if PROMPT_NAME in prompts:
            prompt_id = prompts[PROMPT_NAME]
            print(f"  = prompt {PROMPT_NAME} already exists")
        else:
            prompt = await hub.prompts.create(
                name=PROMPT_NAME,
                description="Weather assistant driven by a plain-Python REST tool loop.",
            )
            prompt_id = prompt.id
            print(f"  + created prompt {PROMPT_NAME}")

        # Checked separately from creating on purpose: a prompt shell with zero
        # versions is a real state (an earlier run that died between the two
        # calls leaves one), and "the name exists" is not "it has content".
        if (await hub.prompts.list_versions(prompt_id)).total == 0:
            version = await hub.prompts.commit_version(
                prompt_id,
                messages=[
                    {"role": "system", "content": "You are a weather assistant. Use the get_weather tool to look up conditions before answering. Never guess."},
                    {"role": "user", "content": "What is the weather in {{ city }} right now?"},
                ],
                model="gpt-4o-mini",
            )
            print(f"  + committed v{version.version_number}")

        await hub.prompts.set_tool_binding(prompt_id, tool_id, tool_alias="production")

        bindings = await hub.prompts.list_tool_bindings(prompt_id)
        print(f"\nprompt_id={prompt_id}")
        print(f"connected tools: {[b.tool_name for b in bindings.default]}")


if __name__ == "__main__":
    asyncio.run(main())
