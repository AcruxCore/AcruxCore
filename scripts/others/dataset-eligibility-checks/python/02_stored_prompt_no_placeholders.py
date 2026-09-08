"""Case 2 — the prompt IS stored in AcruxCore, and has no placeholders.

The version holds both messages verbatim: a fixed system message and a fixed user
message. Nothing varies between runs, so ``prompts.render()`` is called with no variables
and the render result carries ``variables == {}``.

The run therefore has lineage (a prompt_version_id) but nothing to replay against.
Run it, then thumbs-down the trace and try to build a dataset from that feedback — the
point of this script is to see what the build does with an empty variables object.

    ACRUXCORE_API_KEY=... python 02_stored_prompt_no_placeholders.py
"""

import asyncio
import json
import os

from acruxcore import AcruxCore

MODEL = os.environ.get("MODEL", "gpt-4o-mini")
PROMPT_NAME = "eligibility-check-no-placeholders"

# The version this script wants live. Edit these and re-run: `ensure_prompt` commits a
# new version and rolls `production` onto it, so the next trace shows the edit.
MESSAGES = [
    {"role": "system", "content": "You are a AI support agent. Answer in one sentence."},
    {"role": "user", "content": "How do I rotate an API key?"},
]


async def ensure_prompt(hub: AcruxCore):
    """Creates the prompt if missing, then makes sure `production` serves MESSAGES.

    Committing is not enough on its own: only a prompt's FIRST commit mints the
    `production` and `staging` aliases, so every later version has to be promoted
    explicitly or `render(..., "production")` keeps serving the version it was
    pointed at when the prompt was created.
    """
    prompt = None
    existing = await hub.prompts.list(search=PROMPT_NAME, limit=100)
    for p in existing.data:
        if p.name == PROMPT_NAME:
            prompt = p
            break

    if prompt is None:
        prompt = await hub.prompts.create(
            PROMPT_NAME,
            description="No placeholders anywhere — a fixed system message and a fixed question.",
        )
        await hub.prompts.commit_version(prompt.id, MESSAGES, model=MODEL)
        return prompt

    live = await hub.prompts.render(PROMPT_NAME, "production")
    # `live.messages` arrives as plain dicts, not `Message` objects, despite the type
    # hint on RenderResult saying otherwise (issue #417).
    def shape(messages):
        return [(m["role"], m["content"]) for m in messages]

    if shape(live.messages) != shape(MESSAGES):
        version = await hub.prompts.commit_version(prompt.id, MESSAGES, model=MODEL)
        await hub.prompts.promote_alias(prompt.id, "production", version.version_number)
        print(f"committed v{version.version_number}, production now points at it")

    return prompt


async def main() -> None:
    # cache_ttl=0 disables the render cache. This script promotes a new version and
    # then renders again in the same process, and a cached render would serve the
    # version that was live a moment ago.
    async with AcruxCore(cache_ttl=0) as hub:
        prompt = await ensure_prompt(hub)
        rendered = await hub.prompts.render(PROMPT_NAME, "production")

        print(f"prompt:            {prompt.name} ({prompt.id})")
        print(f"render.version_id: {rendered.version_id}")
        print(f"render.variables:  {json.dumps(rendered.variables)}   <- nothing to replay")

        result = await hub.gateway.run_prompt_with_tools(rendered, model=MODEL)

        print(f"\nanswer:  {result.content}")
        print(f"trace:   {result.trace_id}")
        print("\nNext: open the trace, leave a thumbs-down with a comment, then")
        print("Observability → Feedback → select the row → Create dataset.")

        await hub.gateway.aclose()


asyncio.run(main())
