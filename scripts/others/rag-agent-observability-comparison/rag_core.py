"""Shared RAG core for the rag-agent-observability-comparison post.

Retrieval and chunking are identical across every platform script — only the
tracing/observability wrapper around them differs, so the retrieved context is
byte-for-byte identical no matter which platform is instrumenting the run.

The corpus is five OpenTelemetry documentation pages, chosen because they belong
to none of the platforms under comparison. An agent that answered questions
about one of the tools being compared would make the example self-referential,
and its output would appear inside every screenshot.

Needs: pip install chromadb requests beautifulsoup4
Requires OPENROUTER_KEY in the environment.
"""

from __future__ import annotations

import os
from typing import Any

import chromadb
import requests
from bs4 import BeautifulSoup

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
EMBED_MODEL = "openai/text-embedding-3-small"

# A vendor-neutral corpus, deliberately: the agent under test should not answer
# questions about any of the platforms being compared, or the example becomes
# self-referential. OpenTelemetry's own docs are on-topic for a tracing article
# and belong to none of the tools.
DOC_URLS = {
    "traces.md": "https://opentelemetry.io/docs/concepts/signals/traces/",
    "instrumentation.md": "https://opentelemetry.io/docs/concepts/instrumentation/",
    "python.md": "https://opentelemetry.io/docs/languages/python/instrumentation/",
    "semconv.md": "https://opentelemetry.io/docs/concepts/semantic-conventions/",
    "trace-api.md": "https://opentelemetry.io/docs/specs/otel/trace/api/",
}

# One fixed question, asked identically on every platform, so the retrieved
# context and the generated answer are comparable across the whole comparison.
QUESTION = "What is a span, and how do parent and child spans form a trace?"

SYSTEM_PROMPT = (
    "You answer questions about OpenTelemetry using only the documentation "
    "excerpts below. If the excerpts do not contain the answer, say so plainly "
    "instead of guessing.\n\nDocumentation:\n{context}"
)


def fetch_doc_text(url: str) -> str:
    """Download one docs page and return its readable body text."""
    resp = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    container = soup.find("article") or soup.find("main") or soup.body
    for tag in container.find_all(["nav", "aside", "script", "style"]):
        tag.decompose()

    return container.get_text(separator="\n", strip=True)


def chunk_text(text: str, chunk_size: int = 1000, overlap: int = 150) -> list[str]:
    """Split text into overlapping character windows."""
    if chunk_size <= overlap:
        raise ValueError("chunk_size must be greater than overlap")

    chunks: list[str] = []
    step = chunk_size - overlap

    for i in range(0, len(text), step):
        chunk = text[i : i + chunk_size].strip()
        if chunk:
            chunks.append(chunk)
        if i + chunk_size >= len(text):
            break

    return chunks


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of strings through OpenRouter's OpenAI-compatible endpoint."""
    resp = requests.post(
        f"{OPENROUTER_BASE_URL}/embeddings",
        headers={
            "Authorization": f"Bearer {os.environ['OPENROUTER_KEY']}",
            "Content-Type": "application/json",
        },
        json={"model": EMBED_MODEL, "input": texts},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    return [row["embedding"] for row in sorted(data, key=lambda r: r["index"])]


def build_index(collection_name: str = "otel_docs", batch_size: int = 64) -> Any:
    """Fetch every docs page, chunk it, embed it, and load it into a fresh Chroma collection."""
    client = chromadb.Client()
    try:
        client.delete_collection(collection_name)
    except Exception:
        pass
    collection = client.create_collection(
        name=collection_name, metadata={"hnsw:space": "cosine"}
    )

    ids: list[str] = []
    documents: list[str] = []
    metadatas: list[dict[str, Any]] = []

    for source, url in DOC_URLS.items():
        text = fetch_doc_text(url)
        chunks = chunk_text(text)
        for i, chunk in enumerate(chunks):
            ids.append(f"{source}_{i}")
            documents.append(chunk)
            metadatas.append({"source": source, "chunk": i})

    embeddings: list[list[float]] = []
    for start in range(0, len(documents), batch_size):
        embeddings.extend(embed_texts(documents[start : start + batch_size]))

    collection.add(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)
    return collection


def retrieve_context(collection: Any, question: str, top_k: int = 4) -> str:
    """Find the chunks closest to a question and join them into one context block."""
    [query_embedding] = embed_texts([question])
    results = collection.query(query_embeddings=[query_embedding], n_results=top_k)
    chunks = results["documents"][0]
    sources = [m["source"] for m in results["metadatas"][0]]
    return "\n\n".join(f"[{src}]\n{chunk}" for src, chunk in zip(sources, chunks))
