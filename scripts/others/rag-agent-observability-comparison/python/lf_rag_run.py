"""Runs the shared RAG agent (see `scripts/blogs/shared/rag_core.py`) traced
through self-hosted Langfuse. Retrieval opens the parent span by hand;
`langfuse.openai`'s wrapped client nests the generation call inside it
automatically because it runs within the `start_as_current_observation`
context.

Run:
  export LANGFUSE_SECRET_KEY=sk-lf-...
  export LANGFUSE_PUBLIC_KEY=pk-lf-...
  export LANGFUSE_HOST=http://localhost:3050
  export OPENROUTER_KEY=sk-or-v1-...
  python scripts/blogs/rag-agent-observability-comparison/python/lf_rag_run.py

Needs: pip install langfuse openai chromadb requests beautifulsoup4
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langfuse import get_client
from langfuse.openai import openai

import rag_core

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")

langfuse = get_client()
client = openai.OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")

print("Building the index...")
collection = rag_core.build_index()

with langfuse.start_as_current_observation(name="rag-agent", as_type="span") as root:
    root.update(input={"question": rag_core.QUESTION})

    with langfuse.start_as_current_observation(name="search_docs", as_type="span") as retrieval_span:
        context = rag_core.retrieve_context(collection, rag_core.QUESTION)
        retrieval_span.update(input={"query": rag_core.QUESTION}, output={"context": context})

    response = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        temperature=0,
        max_tokens=400,
        messages=[
            {"role": "system", "content": rag_core.SYSTEM_PROMPT.format(context=context)},
            {"role": "user", "content": rag_core.QUESTION},
        ],
        name="rag-agent-generation",
    )
    answer = response.choices[0].message.content
    root.update(output={"answer": answer})
    trace_id = root.trace_id

print(answer)
langfuse.flush()
print(f"\nLangfuse trace id: {trace_id}")
print(f"View at: http://localhost:3050/project/cmsherrj10006k607lkt6tito/traces/{trace_id}")
