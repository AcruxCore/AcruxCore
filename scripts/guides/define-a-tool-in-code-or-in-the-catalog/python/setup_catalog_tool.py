"""
Path B, setup — the same thing the dashboard does when a human fills the form.

Creates the tool shell, commits version 1 with the parameter schema and a
`client` executor, creates the prompt, and binds the tool to it pinned to that
version. Run this only if you would rather not click through the dashboard;
either way it happens once, and never ships with your agent.

Find-or-create throughout, so a second run is a no-op rather than a
TOOL_NAME_TAKEN / PROMPT_NAME_TAKEN error.

Run:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python setup_catalog_tool.py
"""

import asyncio

from acruxcore import AcruxCore

TOOL_NAME = "get_weather_catalog"
PROMPT_NAME = "weather-brief-catalog"


async def main() -> None:
    async with AcruxCore() as hub:
        tools = [t for t in (await hub.tools.list(search=TOOL_NAME)).data if t.name == TOOL_NAME]
        if tools:
            tool_id = tools[0].id
            print(f"  = tool {TOOL_NAME} already in the catalog")
        else:
            # Two calls, not one: a shell has no schema, a version has no name.
            tool = await hub.tools.create(name=TOOL_NAME, description="Weather lookup.")
            tool_id = tool.id
            version = await hub.tools.commit_version(
                tool_id,
                parameters_schema={
                    "type": "object",
                    "properties": {
                        "city": {"type": "string", "description": "City name, e.g. 'Lahore'."}
                    },
                    "required": ["city"],
                },
                executor={"type": "client"},  # "the caller's own app runs this"
                description="Get today's weather for a city.",
            )
            print(f"  + created tool {TOOL_NAME} v{version.version_number}")

        prompts = [
            p for p in (await hub.prompts.list(search=PROMPT_NAME)).data if p.name == PROMPT_NAME
        ]
        if prompts:
            prompt_id = prompts[0].id
            print(f"  = prompt {PROMPT_NAME} already exists")
        else:
            prompt = await hub.prompts.create(
                name=PROMPT_NAME, description="Weather brief, tool defined in the catalog."
            )
            prompt_id = prompt.id
            print(f"  + created prompt {PROMPT_NAME}")

        # Checked separately from creating: a prompt shell with zero versions is a
        # real state, and "the name exists" is not "it has content".
        if (await hub.prompts.list_versions(prompt_id)).total == 0:
            version = await hub.prompts.commit_version(
                prompt_id,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a weather assistant. Call the tool, then answer in one sentence.",
                    }
                ],
                model="gpt-4o-mini",
            )
            print(f"  + committed prompt v{version.version_number}")

        # Pinned to an exact tool version, so the prompt keeps running that build.
        await hub.prompts.set_tool_binding(prompt_id, tool_id, pinned_version_number=1)
        bindings = await hub.prompts.list_tool_bindings(prompt_id)
        print(f"\nbound tools: {[b.tool_name for b in bindings.default]}")


if __name__ == "__main__":
    asyncio.run(main())
