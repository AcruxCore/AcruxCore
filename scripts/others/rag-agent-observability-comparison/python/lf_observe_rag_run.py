"""Runs the shared RAG agent (see `rag_core.py` one folder up) traced through
self-hosted Langfuse using the `@observe` decorator.

This is the counterpart to `lf_rag_run.py`, which uses the
`start_as_current_observation` context manager for the same two spans. Both
work; `@observe` needs no code inside the function body, so it is the
lower-friction of the two and puts Langfuse in the same decorator family as
Opik, MLflow and LangSmith.

`as_type` accepts Langfuse's full observation vocabulary (10 values in 4.14.1),
so the retrieval step is tagged `retriever` instead of a generic span.

Run:
  export LANGFUSE_SECRET_KEY=sk-lf-...
  export LANGFUSE_PUBLIC_KEY=pk-lf-...
  export LANGFUSE_HOST=http://localhost:3050
  export OPENROUTER_KEY=sk-or-v1-...
  python scripts/others/rag-agent-observability-comparison/python/lf_observe_rag_run.py

Needs: pip install langfuse openai chromadb requests beautifulsoup4
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langfuse import get_client, observe
from langfuse.openai import openai

import rag_core

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")
if not os.environ.get("LANGFUSE_SECRET_KEY"):
    sys.exit("LANGFUSE_SECRET_KEY is not set")

langfuse = get_client()
client = openai.OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")


@observe(name="search_docs", as_type="retriever")
def search_docs(collection, query: str) -> str:
    return rag_core.retrieve_context(collection, query)


@observe(name="rag-agent")
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

langfuse.flush()
print(f"\nView at: {os.environ.get('LANGFUSE_HOST', 'http://localhost:3050')}")
