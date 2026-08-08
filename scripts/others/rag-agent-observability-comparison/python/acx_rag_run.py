"""Runs the shared RAG agent (see `scripts/blogs/shared/rag_core.py`) traced
through AcruxCore. Retrieval opens the trace by hand with a single
`hub.traces.ingest()` call, then hands its trace id to `hub.gateway.chat()`
so the generation call lands in the same trace instead of minting its own —
the gateway writes that span server-side, with no tracing code around the
call itself.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1
  export OPENROUTER_KEY=sk-or-v1-...
  python scripts/blogs/rag-agent-observability-comparison/python/acx_rag_run.py

Needs: pip install acruxcore chromadb requests beautifulsoup4
"""

import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import acruxcore as acrux

import rag_core

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")
if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")

PROVIDER: acrux.ProviderConfig = {
    "base_url": "https://openrouter.ai/api/v1",
    "api_key": OPENROUTER_KEY,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def main() -> None:
    print("Building the index...")
    collection = rag_core.build_index()

    async with acrux.AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        started = _now()
        context = rag_core.retrieve_context(collection, rag_core.QUESTION)
        reported = await hub.traces.ingest(
            {
                "name": "rag-agent",
                "spans": [
                    {
                        "spanId": "search_docs",
                        "name": "search_docs",
                        "kind": "retrieval",
                        "status": "ok",
                        "startTime": started,
                        "endTime": _now(),
                        "input": {"query": rag_core.QUESTION},
                        "output": {"context": context},
                    }
                ],
            }
        )

        result = await hub.gateway.chat(
            "openai/gpt-4o-mini",
            [
                {"role": "system", "content": rag_core.SYSTEM_PROMPT.format(context=context)},
                {"role": "user", "content": rag_core.QUESTION},
            ],
            provider=PROVIDER,
            temperature=0,
            max_tokens=400,
            trace={"trace_id": reported.trace_id},
        )

    print(result.content)
    dashboard = BASE_URL.replace("/api/v1", "").replace(":3001", ":5173")
    print(f"\nAcruxCore trace: {reported.trace_id}")
    print(f"View at: {dashboard}/traces/{reported.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
