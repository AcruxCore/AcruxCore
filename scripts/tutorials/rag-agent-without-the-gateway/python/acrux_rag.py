"""RAG over the Acrux Core docs — with a tool, and without the Acrux Core gateway.

Setup:
    pip install acruxcore chromadb requests beautifulsoup4
    export ACRUXCORE_API_KEY=acx_sk_...
    export OPENROUTER_API_KEY=sk-or-...

Run:
    python acrux_rag.py --setup
    python acrux_rag.py "How do I register a new model on the gateway?"
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from typing import Any

import chromadb
import requests
from bs4 import BeautifulSoup

import acruxcore as acrux

ACRUXCORE_BASE_URL = os.environ.get(
    "ACRUXCORE_BASE_URL", "https://api.acruxcore.com/api/v1"
)

# Bring your own key. Present on a gateway.chat() / gateway.run_tool_loop() call, the SDK POSTs
# to base_url directly and skips our gateway. api_key is sent only to OpenRouter.
PROVIDER: acrux.ProviderConfig = {
    "base_url": "https://openrouter.ai/api/v1",
    "api_key": os.environ.get("OPENROUTER_API_KEY", ""),
}

CHAT_MODEL = "openai/gpt-4o-mini"
EMBED_MODEL = "openai/text-embedding-3-small"

LINEAR_PROMPT = "rag-chat"
AGENT_PROMPT = "rag-chat-agent"

DOC_URLS = {
    "prompts.md": "https://docs.acruxcore.com/docs/guides/version-a-prompt",
    "gateway.md": "https://docs.acruxcore.com/docs/guides/route-calls-through-the-gateway",
    "tracing.md": "https://docs.acruxcore.com/docs/guides/trace-an-llm-call",
    "tools.md": "https://docs.acruxcore.com/docs/guides/build-and-attach-a-tool",
    "evaluation.md": "https://docs.acruxcore.com/docs/guides/evaluate-a-prompt",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- 1. Fetch the docs -------------------------------------------------------


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


# --- 2. Embed with OpenRouter ------------------------------------------------


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of strings through OpenRouter's OpenAI-compatible endpoint."""
    resp = requests.post(
        f"{PROVIDER['base_url']}/embeddings",
        headers={
            "Authorization": f"Bearer {PROVIDER['api_key']}",
            "Content-Type": "application/json",
        },
        json={"model": EMBED_MODEL, "input": texts},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    # OpenRouter does not promise input order, so sort by the echoed index.
    return [row["embedding"] for row in sorted(data, key=lambda r: r["index"])]


# --- 3. Index into Chroma ----------------------------------------------------


def build_index(batch_size: int = 64) -> Any:
    """Fetch every docs page, chunk it, embed it, and load it into Chroma."""
    collection = chromadb.Client().get_or_create_collection(
        name="acrux_docs", metadata={"hnsw:space": "cosine"}
    )

    ids: list[str] = []
    documents: list[str] = []
    metadatas: list[dict[str, Any]] = []

    for source, url in DOC_URLS.items():
        text = fetch_doc_text(url)
        chunks = chunk_text(text)
        print(f"  fetched {source}: {len(text):,} chars -> {len(chunks)} chunks")
        for i, chunk in enumerate(chunks):
            ids.append(f"{source}_{i}")
            documents.append(chunk)
            metadatas.append({"source": source, "chunk": i})

    embeddings: list[list[float]] = []
    for start in range(0, len(documents), batch_size):
        embeddings.extend(embed_texts(documents[start : start + batch_size]))

    collection.add(
        ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas
    )
    print(f"  indexed {len(ids)} chunks from {len(DOC_URLS)} documents\n")
    return collection


def retrieve_context(collection: Any, question: str, top_k: int = 4) -> str:
    """Find the chunks closest to a question and join them into one context block."""
    [query_embedding] = embed_texts([question])
    results = collection.query(query_embeddings=[query_embedding], n_results=top_k)
    chunks = results["documents"][0]
    sources = [m["source"] for m in results["metadatas"][0]]
    return "\n\n".join(f"[{src}]\n{chunk}" for src, chunk in zip(sources, chunks))


# --- 4. Linear RAG -----------------------------------------------------------


async def ask_linear(hub: acrux.AcruxCore, collection: Any, question: str) -> str:
    """Answer by retrieving first and calling the model exactly once."""
    started = _now()
    context = retrieve_context(collection, question)
    # Open the trace with the retrieval, then hand its id to chat() so the model
    # call lands in the same trace instead of minting its own.
    reported = await hub.traces.ingest(
        {
            "name": "rag-linear",
            "spans": [
                {
                    "spanId": "retrieval",
                    "name": "search_docs",
                    "kind": "retrieval",
                    "status": "ok",
                    "startTime": started,
                    "endTime": _now(),
                    "input": {"query": question},
                    "output": {"context": context},
                }
            ],
        }
    )

    rendered = await hub.prompts.render(
        LINEAR_PROMPT, "production", {"context": context, "question": question}
    )
    result = await hub.gateway.chat(
        rendered.model or CHAT_MODEL,
        rendered.messages,
        provider=PROVIDER,
        prompt_version_id=rendered.version_id,
        trace={"trace_id": reported.trace_id},
    )
    print(f"  trace: {reported.trace_id}")
    return result.content or ""


# --- 5. Agentic RAG ----------------------------------------------------------

# Set once per run so the decorated tool can reach the index. The decorator
# itself stays pure — it only reads the function signature.
_COLLECTION: Any = None


@acrux.tool
async def search_docs(query: str) -> str:
    """Search Acrux Core's documentation for relevant information.

    Args:
        query: The search query — a question or topic to look up.
    """
    return retrieve_context(_COLLECTION, query)


async def ask_agentic(hub: acrux.AcruxCore, collection: Any, question: str) -> str:
    """Answer by letting the model call search_docs as many times as it wants."""
    global _COLLECTION
    _COLLECTION = collection

    rendered = await hub.prompts.render(AGENT_PROMPT, "production", {"question": question})
    result = await hub.gateway.run_tool_loop(
        rendered.model or CHAT_MODEL,
        rendered.messages,
        tools=[search_docs],
        provider=PROVIDER,
        prompt_version_id=rendered.version_id,
    )
    print(f"  trace: {result.trace_id} ({result.iterations} model calls)")
    return result.content


# --- 6. One-time prompt setup ------------------------------------------------

PROMPT_DEFINITIONS = {
    LINEAR_PROMPT: [
        {
            "role": "system",
            "content": (
                "You answer questions about Acrux Core using only the documentation "
                "excerpts below. If the excerpts do not contain the answer, say so "
                "plainly instead of guessing.\n\n"
                "Documentation:\n{{ context }}"
            ),
        },
        {"role": "user", "content": "{{ question }}"},
    ],
    AGENT_PROMPT: [
        {
            "role": "system",
            "content": (
                "You answer questions about Acrux Core. Use the search_docs tool to "
                "look things up before answering — search more than once if the first "
                "result is thin, or if the question has several parts. Answer only "
                "from what the tool returns, and say so plainly when it comes back "
                "without the answer."
            ),
        },
        {"role": "user", "content": "{{ question }}"},
    ],
}


def setup_prompts(api_key: str) -> None:
    """Create the two prompts this script renders, if they do not exist yet."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    existing = requests.get(f"{ACRUXCORE_BASE_URL}/prompts", headers=headers, timeout=30)
    existing.raise_for_status()
    known = {p["name"] for p in existing.json()["data"]}

    for name, messages in PROMPT_DEFINITIONS.items():
        if name in known:
            print(f"  {name}: already exists, left alone")
            continue

        created = requests.post(
            f"{ACRUXCORE_BASE_URL}/prompts",
            headers=headers,
            json={"name": name},
            timeout=30,
        )
        created.raise_for_status()
        prompt_id = created.json()["id"]

        # No `model` bound on the version on purpose: that field points at the
        # gateway's model registry, and this script never touches the gateway.
        version = requests.post(
            f"{ACRUXCORE_BASE_URL}/prompts/{prompt_id}/versions",
            headers=headers,
            json={"messages": messages},
            timeout=30,
        )
        version.raise_for_status()

        promoted = requests.post(
            f"{ACRUXCORE_BASE_URL}/prompts/{prompt_id}/aliases/production/promote",
            headers=headers,
            json={"version_number": version.json()["versionNumber"]},
            timeout=30,
        )
        promoted.raise_for_status()
        print(f"  {name}: created and promoted to production")


# --- 7. Entry point ----------------------------------------------------------


async def main() -> int:
    parser = argparse.ArgumentParser(description="RAG over the Acrux Core docs.")
    parser.add_argument(
        "question",
        nargs="?",
        default="How do I register a new model on the gateway?",
        help="The question to answer.",
    )
    parser.add_argument(
        "--setup",
        action="store_true",
        help="Create the two prompts in Acrux Core, then exit.",
    )
    args = parser.parse_args()

    api_key = os.environ.get("ACRUXCORE_API_KEY")
    if not api_key:
        print("ACRUXCORE_API_KEY is not set.", file=sys.stderr)
        return 1
    if not PROVIDER["api_key"]:
        print("OPENROUTER_API_KEY is not set.", file=sys.stderr)
        return 1

    if args.setup:
        print("Setting up prompts...")
        setup_prompts(api_key)
        return 0

    print("Building the index...")
    collection = build_index()

    async with acrux.AcruxCore(api_key=api_key, base_url=ACRUXCORE_BASE_URL) as hub:
        print(f"Question: {args.question}\n")

        print("Linear RAG")
        print(await ask_linear(hub, collection, args.question))

        print("\nAgentic RAG")
        print(await ask_agentic(hub, collection, args.question))

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
