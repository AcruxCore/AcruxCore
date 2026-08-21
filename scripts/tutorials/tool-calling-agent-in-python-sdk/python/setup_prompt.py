"""
Create the `query_database` tool and the `sql-analyst-agent` prompt, and connect
them — the Python SDK version of the tutorial's "store it in the framework" steps.

This is the runnable version of the page's two Python tabs (the tool step and the
prompt step). Run it before sql_agent_dispatch.py or
sql_agent_decorator_tool.py, and after seed_db.py has built the local database.

Find-or-create throughout, so a second run is a no-op rather than a
`TOOL_NAME_TAKEN` / `PROMPT_NAME_TAKEN` error.

Run:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python setup_prompt.py
"""

import asyncio
from typing import Any, List

from acruxcore import AcruxCore

TOOL_NAME = "query_database"
TOOL_DESCRIPTION = (
    "Run a single read-only SQL SELECT against the store database and return the "
    "matching rows."
)
PROMPT_NAME = "sql-analyst-agent"


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
            tool = await hub.tools.create(name=TOOL_NAME, description=TOOL_DESCRIPTION)
            version = await hub.tools.commit_version(
                tool.id,
                parameters_schema={
                    "type": "object",
                    "properties": {"sql": {"type": "string", "description": "A single read-only SQLite SELECT statement."}},
                    "required": ["sql"],
                },
                executor={"type": "client"},
            )
            tool_id = tool.id
            print(f"  + created tool {TOOL_NAME} v{version.version_number}")

        if PROMPT_NAME in prompts:
            prompt_id = prompts[PROMPT_NAME]
            print(f"  = prompt {PROMPT_NAME} already exists")
        else:
            prompt = await hub.prompts.create(
                name=PROMPT_NAME,
                description="Text-to-SQL data analyst.",
            )
            prompt_id = prompt.id
            print(f"  + created prompt {PROMPT_NAME}")

        # Checked separately from creating on purpose: a prompt shell with zero
        # versions is a real state (an earlier run that died between the two
        # calls leaves one), and "the name exists" is not "it has content".
        if (await hub.prompts.list_versions(prompt_id)).total == 0:
            version = await hub.prompts.commit_version(
                prompt_id,
                messages=[{"role": "system", "content": "You are a data analyst. Use query_database to answer."}],
                model="gpt-4o-mini",
            )
            print(f"  + committed v{version.version_number}")

        await hub.prompts.set_tool_binding(prompt_id, tool_id, tool_alias="production")

        bindings = await hub.prompts.list_tool_bindings(prompt_id)
        print(f"\nprompt_id={prompt_id}")
        print(f"connected tools: {[b.tool_name for b in bindings.default]}")


if __name__ == "__main__":
    asyncio.run(main())
