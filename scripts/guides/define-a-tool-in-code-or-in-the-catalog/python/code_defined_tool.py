"""
Path A — the definition lives in your code.

`@acrux.tool` derives the tool's name, description and parameter schema from the
function itself. `tools.sync` publishes that definition to the catalog, and
`tools=[fn]` puts it in front of the model. The prompt used here has no tool
binding at all: the tool travels from your process, not from the platform.

Run:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python code_defined_tool.py
"""

import asyncio
import json

from acruxcore import AcruxCore, acrux

PROMPT_NAME = "weather-brief-code"


@acrux.tool
async def get_weather_code(city: str) -> dict:
    """Get today's weather for a city.

    Args:
        city: City name, e.g. 'Lahore'.
    """
    print(f"  -> get_weather_code(city={city!r})")
    return {"city": city, "temp_c": 34, "sky": "hazy sun"}


async def find_or_create_prompt(hub: AcruxCore) -> None:
    """The prompt this path uses. No tool is ever bound to it."""
    found = [p for p in (await hub.prompts.list(search=PROMPT_NAME)).data if p.name == PROMPT_NAME]
    if found:
        return
    prompt = await hub.prompts.create(name=PROMPT_NAME, description="Weather brief, tool defined in code.")
    await hub.prompts.commit_version(
        prompt.id,
        messages=[
            {
                "role": "system",
                "content": "You are a weather assistant. Call the tool, then answer in one sentence.",
            }
        ],
        model="gpt-4o-mini",
    )


async def main() -> None:
    async with AcruxCore() as hub:
        await find_or_create_prompt(hub)

        # The decorator already ran at import time, with no network call. This is
        # the definition it derived, and it is the definition the model will read.
        spec = get_weather_code.__acrux_tool__
        print("definition, derived from the function:")
        print(f"  name:        {spec.name}")
        print(f"  description: {spec.description!r}   <- the docstring's first line")
        print(f"  parameters:  {json.dumps(spec.parameters_schema)}")
        print(f"  executor:    {spec.executor}   <- a decorator can only produce this\n")

        # Publishing is a separate, explicit act. Nothing above touched the network.
        result = (await hub.tools.sync([get_weather_code]))[0]
        print(f"synced to the catalog: v{result.version_number}, alias '{result.alias}'\n")

        rendered = await hub.prompts.render(PROMPT_NAME, "production")
        print(f"tools bound to this prompt: {rendered.tools}   <- empty, on purpose\n")

        run = await hub.gateway.run_tool_loop(
            rendered.model,
            [*rendered.messages, {"role": "user", "content": "What is the weather in Karachi?"}],
            tools=[get_weather_code],
            sync=False,  # already synced above; True would sync inside the loop
            prompt_version_id=rendered.version_id,
            trace={"name": "code-defined-tool"},
        )
        print(f"answer: {run.content}")
        print(f"trace:  {run.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
