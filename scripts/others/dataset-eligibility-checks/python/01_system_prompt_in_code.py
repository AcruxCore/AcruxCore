"""Case 1 — the system prompt lives in code, not in AcruxCore.

Nothing about this run names a prompt version: the messages are built here, in source,
and sent as-is. This is what a LangChain or LangGraph agent looks like from the gateway's
side, and it is the case that has no lineage at all to replay.

Run it, then thumbs-down the trace and try to build a dataset from that feedback.
Expected: the row is skipped with "the prompt is not stored in AcruxCore" — the trace's
spans carry no prompt_version_id, so there is no template to render a candidate against.

    ACRUXCORE_API_KEY=... python 01_system_prompt_in_code.py
"""

import asyncio
import os
import sys

from acruxcore import AcruxCore

MODEL = os.environ.get("MODEL", "gpt-4o-mini")

# The prompt AcruxCore never sees.
SYSTEM_PROMPT = "You are a terse support agent. Answer in one sentence."


async def main() -> None:
    # `.strip()` guards a blank argument: an empty user message is a 400 from the
    # gateway ("content must not be empty"), which is a confusing way to learn you
    # forgot the question.
    question = (sys.argv[1].strip() if len(sys.argv) > 1 else "") or "How do I rotate an API key?"

    async with AcruxCore() as hub:
        result = await hub.gateway.chat(
            MODEL,
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": question},
            ],
            # No prompt_version_id and no variables — there is nothing to name.
        )

        print(f"answer:  {result.content}")
        print(f"trace:   {result.gateway.trace_id}")
        print("\nNext: open the trace, leave a thumbs-down with a comment, then")
        print("Observability → Feedback → select the row → Create dataset.")

        await hub.gateway.aclose()


asyncio.run(main())
