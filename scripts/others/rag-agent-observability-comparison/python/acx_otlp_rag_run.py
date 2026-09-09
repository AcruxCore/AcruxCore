"""Runs the shared RAG agent (see `rag_core.py` one folder up) traced through
AcruxCore's OTLP receiver using plain OpenTelemetry.

This is the counterpart to `acx_rag_run.py`, which reports the retrieval span
with an awaited `traces.ingest()` call. Here nothing AcruxCore-specific appears
around the work itself: `acruxcore.otel.register()` builds a standard
`TracerProvider` with a `BatchSpanProcessor` pointed at
`POST /api/v1/traces/otlp`, and the spans are ordinary OTel spans. The same
instrumentation would export to any other OTLP-compatible backend by changing
the endpoint and nothing else.

Because the exporter batches on a background thread, the span costs the caller
an in-memory append rather than a network round trip — the same trade every
OTel-based pipeline makes.

Requires the `otel` extra and an SDK build that ships `acruxcore.otel`
(0.8.0+): `pip install "acruxcore[otel]"`.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1
  export OPENROUTER_KEY=sk-or-v1-...
  python scripts/others/rag-agent-observability-comparison/python/acx_otlp_rag_run.py

Needs: pip install "acruxcore[otel]" openinference-instrumentation-openai \
                   openai chromadb requests beautifulsoup4
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from acruxcore import otel
from openinference.instrumentation.openai import OpenAIInstrumentor
from openai import OpenAI

import rag_core

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")
if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")

# One call replaces the TracerProvider + BatchSpanProcessor + OTLPSpanExporter
# wiring; the provider it returns is a plain OTel provider.
tracer_provider = otel.register(service_name="rag-agent-observability")

# Auto-instruments the OpenAI client against that provider, so the generation
# call nests under whatever span is current — no tracing code at the call site.
OpenAIInstrumentor().instrument(tracer_provider=tracer_provider)

tracer = tracer_provider.get_tracer(__name__)
client = OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")

print("Building the index...")
collection = rag_core.build_index()

with tracer.start_as_current_span("rag-agent") as root:
    root.set_attribute("input.value", rag_core.QUESTION)

    with tracer.start_as_current_span("search_docs") as retrieval_span:
        retrieval_span.set_attribute("openinference.span.kind", "RETRIEVER")
        retrieval_span.set_attribute("input.value", rag_core.QUESTION)
        context = rag_core.retrieve_context(collection, rag_core.QUESTION)
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

print(answer)

# Flush before exit so the batch processor doesn't lose the trace on shutdown.
tracer_provider.force_flush()
print(f"\nReported to {os.environ['ACRUXCORE_BASE_URL']}/traces/otlp")
