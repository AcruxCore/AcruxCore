"""Case 4 — the system prompt is committed, the user turn is sent live, and declared.

Identical to case 3 in every respect but one: the call passes ``variables={"question":
...}`` alongside the messages it already rendered itself. The gateway does not re-render
anything — the messages are sent exactly as given — it only records the values behind them.

That one keyword is the whole difference between a run an evaluation can replay and one it
cannot. The span stores ``variables = {"question": "..."}``, the dataset build produces an
example whose input holds the question, and an experiment can render a candidate system
prompt against that same question.

Run this and case 3 back to back, thumbs-down both, then select both feedback rows and
build one dataset: it reports one added and one skipped.

    ACRUXCORE_API_KEY=... python 04_live_user_turn_with_variables.py "your question"
"""

import asyncio
import json
import os
import sys

from acruxcore import AcruxCore

MODEL = os.environ.get("MODEL", "gpt-4o-mini")
PROMPT_NAME = "eligibility-check-live-user-turn"

# The committed version. A system message and nothing else — the user turn is not part of
# the stored prompt at all, which is what makes this different from cases 1 and 2.
MESSAGES = [
    {"role": "system", "content": "You are a AI support agent. Answer in one sentence."},
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
            description="System prompt only — the user turn is appended by the caller at request time.",
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
    # `.strip()` guards a blank argument: an empty user message is a 400 from the
    # gateway ("content must not be empty"), which is a confusing way to learn you
    # forgot the question.
    question = (sys.argv[1].strip() if len(sys.argv) > 1 else "") or "How do I rotate an API key?"

    # cache_ttl=0 disables the render cache. This script promotes a new version and
    # then renders again in the same process, and a cached render would serve the
    # version that was live a moment ago.
    async with AcruxCore(cache_ttl=0) as hub:
        prompt = await ensure_prompt(hub)
        rendered = await hub.prompts.render(PROMPT_NAME, "production")

        # The live turn, appended client-side. The gateway is sent finished messages, so
        # it renders nothing — `messages` and `prompt` are mutually exclusive on the API.
        messages = list(rendered.messages) + [{"role": "user", "content": question}]

        # Declaring the same value the message text already contains. It is not sent to
        # the model and changes nothing about the call — it is recorded on the span so an
        # evaluation knows what this run varied.
        variables = {"question": question}

        print(f"prompt:            {prompt.name} ({prompt.id})")
        print(f"render.version_id: {rendered.version_id}")
        print(f"stored messages:   {json.dumps([m['role'] for m in rendered.messages])}")
        print(f"messages sent:     {json.dumps([m['role'] for m in messages])}")
        print(f"variables sent:    {json.dumps(variables)}   <- what an experiment replays")

        result = await hub.gateway.chat(
            model=MODEL,
            messages=messages,
            prompt_version_id=rendered.version_id,
            variables=variables,
        )

        print(f"\nanswer:  {result.content}")
        print(f"trace:   {result.gateway.trace_id}")
        print("\nExpect this one to be ADDED, with the question as the example's input.")

        await hub.gateway.aclose()


asyncio.run(main())
