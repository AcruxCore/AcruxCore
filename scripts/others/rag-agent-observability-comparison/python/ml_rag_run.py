"""Runs the shared RAG agent (see `rag_core.py` one folder up) traced through
self-hosted MLflow. `@mlflow.trace` decorates the functions that already
exist, and `mlflow.openai.autolog()` patches the OpenAI client so the
generation call is captured as a nested child with no tracing code at the call
site — the same decorator shape Opik, LangSmith and Langfuse's `@observe` use.

MLflow's `span_type` accepts the widest vocabulary of any platform in this
comparison (15 values, including RERANKER, GUARDRAIL and EVALUATOR), so the
retrieval step is tagged RETRIEVER rather than a generic span.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  export MLFLOW_TRACKING_URI=http://localhost:5000
  python scripts/others/rag-agent-observability-comparison/python/ml_rag_run.py

Needs: pip install mlflow openai chromadb requests beautifulsoup4
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mlflow
from mlflow.entities import SpanType
from openai import OpenAI

import rag_core

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")

TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")
EXPERIMENT_NAME = "rag-agent-observability"

mlflow.set_tracking_uri(TRACKING_URI)
mlflow.set_experiment(EXPERIMENT_NAME)

# Patches the OpenAI SDK so chat.completions.create() emits an LLM span that
# nests under whichever @mlflow.trace span is active when it runs.
mlflow.openai.autolog()

client = OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")


@mlflow.trace(name="search_docs", span_type=SpanType.RETRIEVER)
def search_docs(collection, query: str) -> str:
    return rag_core.retrieve_context(collection, query)


@mlflow.trace(name="rag-agent", span_type=SpanType.CHAIN)
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

mlflow.flush_trace_async_logging()
print(f"\nView at: {TRACKING_URI} (experiment: {EXPERIMENT_NAME})")
