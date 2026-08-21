"""
Create the `react-agent-finance` prompt and connect its two tools — the Python
SDK half of Step 4 of the tutorial.

This is the runnable version of the page's Python tab. Run it before
react_agent.py, and after create_tools.py has registered the tools (it will
create bare catalog shells for any that are missing, so the binding step can
still run on a fresh team).

Find-or-create throughout, so a second run is a no-op rather than a
`TOOL_NAME_TAKEN` / `PROMPT_NAME_TAKEN` error.

Run:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python setup_prompt.py
"""

import asyncio
from typing import Any, Dict, List

from acruxcore import AcruxCore

PROMPT_NAME = "react-agent-finance"
PROMPT_DESCRIPTION = (
    "ReAct-style finance research agent, called directly against OpenAI (no gateway)."
)
SYSTEM_PROMPT = (
    "You are a financial research assistant. Reason step by step about what the question "
    "actually needs before answering. Use the finance_research tool to look up recent "
    "Yahoo Finance news for a stock ticker, and the get_todays_date tool whenever the "
    "question depends on today's date (relative dates, whether markets are open, and "
    "similar). Only call a tool when its result is genuinely needed, then give a clear "
    "final answer grounded in what the tools returned."
)

#: The tools this prompt calls, with the schema each would be registered with by
#: `create_tools.py`. Only used when the tool is not in the catalog yet.
TOOLS: Dict[str, Dict[str, Any]] = {
    "finance_research": {
        "description": "Search Yahoo Finance news for a ticker symbol.",
        "schema": {
            "type": "object",
            "properties": {"ticker_symbol": {"type": "string", "description": "The ticker symbol to research."}},
            "required": ["ticker_symbol"],
        },
    },
    "get_todays_date": {
        "description": "Quick tool to get today's date.",
        "schema": {"type": "object", "properties": {}},
    },
}


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


async def ensure_tools(hub: AcruxCore) -> List[str]:
    """Tool ids for every name in TOOLS, creating a catalog shell if needed."""
    existing = {t["name"]: t["id"] for t in await page(hub, "/tools")}
    ids = []
    for name, spec in TOOLS.items():
        if name in existing:
            print(f"  = tool {name} already in the catalog")
            ids.append(existing[name])
            continue
        tool = await hub.tools.create(name, description=spec["description"])
        await hub.tools.commit_version(tool.id, spec["schema"], {"type": "client"},
                                       description=spec["description"])
        print(f"  + created tool {name}")
        ids.append(tool.id)
    return ids


async def main() -> None:
    async with AcruxCore() as hub:
        tool_ids = await ensure_tools(hub)

        existing = {p["name"]: p["id"] for p in await page(hub, "/prompts")}
        if PROMPT_NAME in existing:
            prompt_id = existing[PROMPT_NAME]
            print(f"  = prompt {PROMPT_NAME} already exists")
        else:
            # Create the prompt shell
            prompt = await hub.prompts.create(PROMPT_NAME, description=PROMPT_DESCRIPTION)
            prompt_id = prompt.id
            print(f"  + created prompt {PROMPT_NAME}")

        # Checked separately from creating on purpose: a prompt shell with zero
        # versions is a real state (an earlier run that died between the two
        # calls leaves one), and "the name exists" is not "it has content".
        if (await hub.prompts.list_versions(prompt_id)).total == 0:
            # Commit a version with the messages — the template only
            version = await hub.prompts.commit_version(
                prompt_id,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": "{{ question }}"},
                ],
            )
            print(f"  + committed v{version.version_number}")

        # Connect both tools — the default binding, inherited by every alias
        for tool_id in tool_ids:
            await hub.prompts.set_tool_binding(prompt_id, tool_id, tool_alias="production")

        bindings = await hub.prompts.list_tool_bindings(prompt_id)
        print(f"\nprompt_id={prompt_id}")
        print(f"connected tools: {[b.tool_name for b in bindings.default]}")


if __name__ == "__main__":
    asyncio.run(main())
