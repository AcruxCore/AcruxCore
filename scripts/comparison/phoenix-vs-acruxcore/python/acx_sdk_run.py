"""Runs the same vip-support-triage completion through the `acruxcore` Python SDK.

Contrast with `lf_trace_run.py`: Langfuse has no stored-prompt concept, so that
script inlines the system/user text and wraps a normal OpenAI call. Here the
prompt lives on the platform — `hub.prompts.render()` fetches and fills the
`vip-support-triage@production` template, `hub.gateway.chat()` sends it through
the gateway, and the trace (with prompt-version lineage attached) is written
server-side with no tracing code in this file at all.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1
  python scripts/blogs/acruxcore-vs-langfuse/python/acx_sdk_run.py

Needs: pip install acruxcore
"""

import asyncio
import json
import os
import sys

from acruxcore import AcruxCore

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")

VARIABLES = {
    "company": "Acme Corp",
    "customer_message": (
        "Hi, my export button is greyed out again and I have two open tickets "
        "already. Can someone look at this today?"
    ),
    "is_vip": True,
    "tickets": [
        {"id": "4821", "title": "Billing export button greyed out"},
        {"id": "4790", "title": "SSO login redirect loop"},
    ],
}


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        rendered = await hub.prompts.render("vip-support-triage", "production", VARIABLES)

        result = await hub.gateway.chat(
            rendered.model,
            rendered.messages,
            temperature=0,
            max_tokens=256,
            prompt_version_id=rendered.version_id,
        )

    print(
        json.dumps(
            {
                "content": result.content,
                "model": result.model,
                "prompt_tokens": result.usage.prompt_tokens,
                "completion_tokens": result.usage.completion_tokens,
                "cost_usd": result.gateway.cost_usd,
                "trace_id": result.gateway.trace_id,
            },
            indent=2,
        )
    )
    print(f"\nAcruxCore trace: {BASE_URL.replace('/api/v1', '')}/traces/{result.gateway.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
