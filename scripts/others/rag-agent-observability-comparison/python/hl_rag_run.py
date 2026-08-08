"""Runs the shared RAG agent (see `scripts/blogs/shared/rag_core.py`) against
self-hosted Helicone.

Helicone has no SDK call for a custom, non-LLM span — the request-path proxy
only wraps `chat.completions.create()`-shaped calls, so the retrieval step
here runs untraced, then the generation call is sent directly to OpenRouter
and logged afterwards via Helicone's manual `/v1/trace/custom/log` endpoint
on the self-hosted `jawn` service.

This reproduces the exact failure documented in the earlier
`helicone-vs-acruxcore` comparison post: the self-hosted docker-compose ships
without an `S3_REGION` env var, so the log endpoint 500s constructing its S3
client before the trace ever reaches ClickHouse. That bug is still present —
confirmed again on this run.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  export HELICONE_API_KEY=sk-helicone-...
  export HELICONE_BASE_URL=http://localhost:8585   # self-hosted jawn service
  python scripts/blogs/rag-agent-observability-comparison/python/hl_rag_run.py

Needs: pip install requests chromadb beautifulsoup4
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests

import rag_core

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
HELICONE_API_KEY = os.environ.get("HELICONE_API_KEY")
HELICONE_BASE_URL = os.environ.get("HELICONE_BASE_URL", "http://localhost:8585")

if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")
if not HELICONE_API_KEY:
    sys.exit("HELICONE_API_KEY is not set")

print("Building the index...")
collection = rag_core.build_index()

print("Retrieving context (untraced — Helicone has no custom-span call)...")
context = rag_core.retrieve_context(collection, rag_core.QUESTION)

body = {
    "model": "openai/gpt-4o-mini",
    "temperature": 0,
    "max_tokens": 400,
    "messages": [
        {"role": "system", "content": rag_core.SYSTEM_PROMPT.format(context=context)},
        {"role": "user", "content": rag_core.QUESTION},
    ],
}

start = time.time()
res = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
    json=body,
    timeout=30,
)
end = time.time()
res.raise_for_status()
data = res.json()
print("\nDirect OpenRouter completion:")
print(data["choices"][0]["message"]["content"])

log_body = {
    "providerRequest": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "json": body,
        "meta": {},
    },
    "providerResponse": {"json": data, "status": res.status_code, "headers": {}},
    "timing": {
        "startTime": {"seconds": int(start), "milliseconds": int((start % 1) * 1000)},
        "endTime": {"seconds": int(end), "milliseconds": int((end % 1) * 1000)},
    },
}

log_res = requests.post(
    f"{HELICONE_BASE_URL}/v1/trace/custom/log",
    headers={"Authorization": f"Bearer {HELICONE_API_KEY}", "Content-Type": "application/json"},
    json=log_body,
    timeout=30,
)
print(f"\nHelicone manual-log attempt: HTTP {log_res.status_code}")
print(log_res.text[:600])
if log_res.status_code >= 400:
    print(
        "\nSame failure as the earlier comparison post: self-hosted Helicone's "
        "custom logger 500s on a missing S3_REGION env var in its own "
        "docker-compose, before the trace ever reaches ClickHouse."
    )
