"""One-time setup for the AcruxCore leg: the tool, the prompt, and the binding.

This is the work the dashboard does when someone fills in the forms, written as code
so the comparison counts it. It runs once per team. The agent scripts never repeat it.

1. Creates the `get_weather` tool and commits version 1 with an `http` executor.
   The platform runs that version: it calls wttr.in and trims the reply itself.
2. Creates the `weather-advisor` prompt and commits version 1, bound to the gateway
   model `gpt-4o-mini`.
3. Binds the tool to the prompt, following the tool's `production` alias.

Find-or-create throughout, so a second run changes nothing.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/setup_acruxcore.py

Needs: pip install acruxcore requests
"""

import asyncio
import os
import sys
from pathlib import Path

from acruxcore import AcruxCore

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from weather_tool_shared import (  # noqa: E402
    MODEL_ACRUXCORE,
    SYSTEM_PROMPT,
    WEATHER_HTTP_EXECUTOR,
    WEATHER_TOOL_SCHEMA,
)

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
PROMPT_NAME = "weather-advisor"

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        fn = WEATHER_TOOL_SCHEMA["function"]
        found = [t for t in (await hub.tools.list(search=fn["name"])).data if t.name == fn["name"]]
        if found:
            tool_id = found[0].id
        else:
            # Two calls: the tool holds the name, each version holds the schema and executor.
            tool_id = (await hub.tools.create(name=fn["name"])).id
            await hub.tools.commit_version(
                tool_id,
                parameters_schema=fn["parameters"],
                executor=WEATHER_HTTP_EXECUTOR,
                description=fn["description"],
            )

        found = [p for p in (await hub.prompts.list(search=PROMPT_NAME)).data if p.name == PROMPT_NAME]
        prompt_id = found[0].id if found else (await hub.prompts.create(name=PROMPT_NAME)).id
        if (await hub.prompts.list_versions(prompt_id)).total == 0:
            await hub.prompts.commit_version(
                prompt_id,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": "Should I go for a run in {{ city }} this evening?"},
                ],
                model=MODEL_ACRUXCORE,
            )

        # The default binding, so every alias of the prompt calls the tool's production version.
        await hub.prompts.set_tool_binding(prompt_id, tool_id, tool_alias="production")
        print(f"tool {fn['name']} ({tool_id}) is bound to prompt {PROMPT_NAME} ({prompt_id})")


if __name__ == "__main__":
    asyncio.run(main())
