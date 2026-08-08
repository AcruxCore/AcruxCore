"""Runs the shared RAG agent (see `scripts/blogs/shared/rag_core.py`) traced
through self-hosted Opik. `@opik.track` on both the outer function and the
retrieval function nests them by call stack; `track_openai()` patches the
client so the generation call is captured as a third, automatically nested
span with no tracing code at the call site itself.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  export OPIK_URL_OVERRIDE=http://localhost:5273/api   # self-hosted Opik, no auth needed
  export OPIK_WORKSPACE=default
  python scripts/blogs/rag-agent-observability-comparison/python/op_rag_run.py

Needs: pip install opik openai chromadb requests beautifulsoup4
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import opik
from opik.integrations.openai import track_openai
from openai import OpenAI

import rag_core

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")

os.environ.setdefault("OPIK_URL_OVERRIDE", "http://localhost:5273/api")
os.environ.setdefault("OPIK_WORKSPACE", "default")
PROJECT_NAME = "rag-agent-observability"

client = track_openai(
    OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1"),
    project_name=PROJECT_NAME,
)


@opik.track(name="search_docs", project_name=PROJECT_NAME)
def search_docs(collection, query: str) -> str:
    return rag_core.retrieve_context(collection, query)


@opik.track(name="rag-agent", project_name=PROJECT_NAME)
def ask(collection, question: str) -> str:
    context = search_docs(collection, question)
    response = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        temperature=0,
        max_tokens=400,
        messages=[
            {"role": "system", "content": rag_core.SYSTEM_PROMPT.format(context=context)},
            {"role": "user", "content": question},
        ],
    )
    return response.choices[0].message.content


print("Building the index...")
collection = rag_core.build_index()

answer = ask(collection, rag_core.QUESTION)
print(answer)

opik.flush_tracker()
print(f"\nView at: http://localhost:5273/default/projects (project: {PROJECT_NAME})")
