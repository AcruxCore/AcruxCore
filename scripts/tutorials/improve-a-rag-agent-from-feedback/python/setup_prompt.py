"""Create the ``brewline-support`` prompt with its first version.

Run once, before agent.py. A second run changes nothing.

Setup:
    pip install acruxcore
    export ACRUXCORE_API_KEY=acx_sk_...
    export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
    export ACRUXCORE_MODEL=gpt-4o-mini     # a model name from Gateway -> Models

Run:
    python setup_prompt.py
"""

import asyncio
import os

from acruxcore import AcruxCore

PROMPT = "brewline-support"
MODEL = os.getenv("ACRUXCORE_MODEL", "gpt-4o-mini")

SYSTEM = (
    "You are the customer support assistant for Brewline, an online shop for coffee "
    "grinders, espresso machines and brewing gear. Today is {{ today }}.\n\n"
    "Be friendly and answer in two to four sentences. Use the tools when you need "
    "store information."
)


async def main() -> None:
    async with AcruxCore() as hub:
        found = [p for p in (await hub.prompts.list(search=PROMPT)).data if p.name == PROMPT]
        if found:
            prompt_id = found[0].id
            print(f"= prompt {PROMPT} already exists")
        else:
            prompt_id = (await hub.prompts.create(PROMPT, description="Brewline customer support agent.")).id
            print(f"+ created prompt {PROMPT}")

        if (await hub.prompts.list_versions(prompt_id)).total == 0:
            # The first version also creates the production and staging aliases.
            version = await hub.prompts.commit_version(
                prompt_id,
                messages=[
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": "{{ question }}"},
                ],
                model=MODEL,
            )
            print(f"+ committed v{version.version_number} on {MODEL}")
        print(f"prompt_id={prompt_id}")


if __name__ == "__main__":
    asyncio.run(main())
