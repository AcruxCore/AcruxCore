"""Runs the shared RAG agent (see `scripts/blogs/shared/rag_core.py`) traced
through Phoenix. Phoenix has no "trace this function" decorator of its own —
this uses the raw OTel tracer for the outer span and the retrieval span, and
lets `OpenAIInstrumentor` auto-wrap the OpenAI client so the generation call
nests as a third child span with no tracing code at the call site.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  python scripts/blogs/rag-agent-observability-comparison/python/px_rag_run.py

Needs: pip install arize-phoenix-otel openinference-instrumentation-openai openai chromadb requests beautifulsoup4
Phoenix must be running locally at http://localhost:6006 (or set PHOENIX_COLLECTOR_ENDPOINT).
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from phoenix.otel import register
from openinference.instrumentation.openai import OpenAIInstrumentor
from openai import OpenAI

import rag_core

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
PHOENIX_ENDPOINT = os.environ.get("PHOENIX_COLLECTOR_ENDPOINT", "http://localhost:6006")

if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")

tracer_provider = register(
    endpoint=f"{PHOENIX_ENDPOINT}/v1/traces",
    project_name="rag-agent-observability",
    auto_instrument=False,
)
OpenAIInstrumentor().instrument(tracer_provider=tracer_provider)
tracer = tracer_provider.get_tracer(__name__)

client = OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")

print("Building the index...")
collection = rag_core.build_index()

with tracer.start_as_current_span("rag-agent") as root:
    root.set_attribute("input.value", rag_core.QUESTION)

    with tracer.start_as_current_span("search_docs") as retrieval_span:
        context = rag_core.retrieve_context(collection, rag_core.QUESTION)
        retrieval_span.set_attribute("input.value", rag_core.QUESTION)
        retrieval_span.set_attribute("output.value", context)

    response = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        temperature=0,
        max_tokens=400,
        messages=[
            {"role": "system", "content": rag_core.SYSTEM_PROMPT.format(context=context)},
            {"role": "user", "content": rag_core.QUESTION},
        ],
    )
    answer = response.choices[0].message.content
    root.set_attribute("output.value", answer)
    span_context = root.get_span_context()

print(answer)
print(f"\nView at: {PHOENIX_ENDPOINT}/projects (project: rag-agent-observability)")
print(f"Trace id: {format(span_context.trace_id, '032x')}")
