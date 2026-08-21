"""
Create the supervisor's router prompt and its subagent prompts, and connect each
subagent's tools — the Python SDK version of the tutorial's prompt-creation step.

This is the runnable version of the page's Python tab, which shows the router and
the finance subagent and then says "Repeat for general-research-agent and
writing-agent…". This script does all four, so the whole set really exists.

Run it after create_tools.py (which registers the tools) and before
supervisor_flow.py. Find-or-create throughout, so a second run is a no-op.

Each prompt carries a default model, and the API rejects a version whose model is
not registered for the team ("Model 'x' is not registered for this team", 400).
The tutorial registers `claude-haiku-direct` earlier on; set ACRUXCORE_MODEL to
whatever you called yours if it differs. The registry is checked up front so the
failure is one clear message rather than a 400 from the third call.

Run:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  export ACRUXCORE_MODEL=claude-haiku-direct   # optional, this is the default
  python setup_prompts.py
"""

import asyncio
import os
from typing import Any, Dict, List

from acruxcore import AcruxCore

MODEL = os.environ.get("ACRUXCORE_MODEL", "claude-haiku-direct")

ROUTER_SYSTEM = (
    "You are the Executive Content Director orchestrating a team of specialized AI agents "
    "to produce exceptional content for clients.\n\nAvailable agents:\n"
    "- finance_research_agent: Specialized in financial data research and analysis using "
    "Yahoo Finance and other financial sources\n"
    "- general_research_agent: Expert at comprehensive web research on any topic using "
    "advanced search tools\n"
    "- writing_agent: Professional content writer that creates final polished content in "
    "any format\n\nRead the user's request and decide which single agent should handle it next."
)
FINANCE_SYSTEM = (
    "You are an expert finance research assistant for a digital content agency.\n"
    "You have access to the following tools: finance_research, basic_research, and "
    "get_todays_date. \nFirst get today's date then continue. \nThe finance_research tool "
    "is used to search for financial data and news from Yahoo Finance. \nThe basic_research "
    "tool is used to search for general information. \nThe get_todays_date tool is used to "
    "get today's date. \nWhen you are done with your research, return the research to the "
    "supervisor agent."
)
GENERAL_SYSTEM = (
    "You are an expert research assistant for a digital content agency. Use "
    "advanced_research for depth and basic_research for quick lookups, and get_todays_date "
    "whenever the answer depends on today's date. Return your findings to the supervisor agent."
)
WRITING_SYSTEM = (
    "You are a professional content writer for a digital content agency. Turn the research "
    "you are given into polished, publication-ready content in the requested format. Do not "
    "invent facts that are not in the research."
)

#: name -> (description, user-message variable, system prompt, tool names)
PROMPTS: List[Dict[str, Any]] = [
    {
        "name": "content-supervisor",
        "description": "Classifies an incoming content request and routes it to one of three specialist subagents.",
        "variable": "question",
        "system": ROUTER_SYSTEM,
        "tools": [],
    },
    {
        "name": "finance-research-agent",
        "description": "Finance research subagent: Yahoo Finance news plus quick web lookups, for the content supervisor.",
        "variable": "task",
        "system": FINANCE_SYSTEM,
        "tools": ["finance_research", "basic_research", "get_todays_date"],
    },
    {
        "name": "general-research-agent",
        "description": "General research subagent: deep and quick web research, for the content supervisor.",
        "variable": "task",
        "system": GENERAL_SYSTEM,
        "tools": ["advanced_research", "basic_research", "get_todays_date"],
    },
    {
        "name": "writing-agent",
        "description": "Writing subagent: turns gathered research into finished content.",
        "variable": "task",
        "system": WRITING_SYSTEM,
        "tools": [],
    },
]


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


async def assert_model_registered(hub: AcruxCore) -> None:
    """Fail early, and clearly, if MODEL is not in the team's model registry.

    Without this the first `commit_version` returns a bare 400 three calls in,
    having already created a prompt shell that the reader then has to clean up.
    """
    res = await hub._request("GET", "/gateway/models", None, "listing gateway models")
    body = res.json()
    rows = body.get("data", body) if isinstance(body, dict) else body
    names = [m.get("publicName") for m in rows] if isinstance(rows, list) else []
    if MODEL not in names:
        raise SystemExit(
            f"Model {MODEL!r} is not registered for this team.\n"
            f"Registered models: {names or '(none)'}\n"
            "Register it under Gateway -> Models, or set ACRUXCORE_MODEL to one of the above."
        )


async def main() -> None:
    async with AcruxCore() as hub:
        await assert_model_registered(hub)
        tools = {t["name"]: t["id"] for t in await page(hub, "/tools")}
        prompts = {p["name"]: p["id"] for p in await page(hub, "/prompts")}

        for spec in PROMPTS:
            name = spec["name"]
            if name in prompts:
                prompt_id = prompts[name]
                print(f"  = prompt {name} already exists")
            else:
                created = await hub.prompts.create(name, description=spec["description"])
                prompt_id = created.id
                print(f"  + created prompt {name}")

            # Committing is checked separately from creating on purpose. A prompt
            # shell with zero versions is a real state — an earlier run that died
            # between the two calls leaves one — and "the name exists" is not the
            # same as "it has content". Skipping the commit there would leave a
            # prompt that renders nothing.
            if (await hub.prompts.list_versions(prompt_id)).total == 0:
                version = await hub.prompts.commit_version(
                    prompt_id,
                    model=MODEL,
                    messages=[
                        {"role": "system", "content": spec["system"]},
                        {"role": "user", "content": "{{ %s }}" % spec["variable"]},
                    ],
                )
                print(f"    + committed v{version.version_number}")

            missing = [t for t in spec["tools"] if t not in tools]
            if missing:
                print(f"    ! skipped binding {missing} — run create_tools.py first")
            for tool_name in spec["tools"]:
                if tool_name in tools:
                    await hub.prompts.set_tool_binding(prompt_id, tools[tool_name], tool_alias="production")

            bindings = await hub.prompts.list_tool_bindings(prompt_id)
            print(f"    {name}: {[b.tool_name for b in bindings.default] or 'no tools (router)'}")


if __name__ == "__main__":
    asyncio.run(main())
