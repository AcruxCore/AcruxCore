"""Brewline's support agent: retrieval over the store's policies, plus an order lookup.

Two tools, both running in this process:

- ``search_policies`` searches the policy paragraphs that ``index_policies.py`` stored
  as vectors in Milvus.
- ``lookup_order`` reads one order from ``../data/orders.json``, which stands in for
  the store's order database.

The prompt itself lives in AcruxCore as ``brewline-support`` (``setup_prompt.py``
creates it), so its wording can change without a deploy.

Setup:
    pip install acruxcore "pymilvus[model]"
    export ACRUXCORE_API_KEY=acx_sk_...
    export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
    export MILVUS_URI=http://localhost:19530      # a Milvus server, or a Milvus Lite file
    python index_policies.py                      # once, before the first run

Run:
    python agent.py "Can I return the kettle from order BR-1088?"
    python agent.py            # every question in ../data/questions.json
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pymilvus import MilvusClient, model

from acruxcore import AcruxCore, acrux

PROMPT = "brewline-support"
DATA = Path(__file__).resolve().parent.parent / "data"
MILVUS_URI = os.getenv("MILVUS_URI", "http://localhost:19530")
COLLECTION = "brewline_policies"

#: The date the agent treats as today. Fixed, so the orders' delivery dates give the
#: same answers on every run; a real app passes the real date.
TODAY = "2026-10-26"


# --- the policy search -----------------------------------------------------------

#: A small sentence-embedding model that runs on this machine. It must be the model
#: index_policies.py used, or the query and the paragraphs are not comparable.
EMBED = model.DefaultEmbeddingFunction()
MILVUS = MilvusClient(MILVUS_URI)
ORDERS: Dict[str, Any] = json.loads((DATA / "orders.json").read_text())


def search_policy_store(query: str, k: int = 4) -> List[Dict[str, str]]:
    """The ``k`` policy paragraphs closest in meaning to ``query``, closest first."""
    hits = MILVUS.search(COLLECTION, EMBED.encode_queries([query]), limit=k, output_fields=["source", "text"])[0]
    return [{"source": hit["entity"]["source"], "text": hit["entity"]["text"]} for hit in hits]


# --- the two tools ---------------------------------------------------------------


@acrux.tool
async def search_policies(query: str) -> List[Dict[str, str]]:
    """Search Brewline's store policies (returns, refunds, warranty, shipping, grinder care).

    Args:
        query: What to look for, in a few words, e.g. "return used grinder".
    """
    return search_policy_store(query)


@acrux.tool
async def lookup_order(order_id: str) -> Dict[str, Any]:
    """Look up one customer order: its items, whether they were used, and its delivery date.

    Args:
        order_id: The order number, e.g. "BR-1042".
    """
    order = ORDERS.get(order_id.strip().upper())
    return {"order_id": order_id, **order} if order else {"error": f"No order {order_id}."}


# --- the agent -------------------------------------------------------------------


async def ask(hub: AcruxCore, question: str, trace: Optional[Dict[str, Any]] = None) -> Tuple[str, Optional[str]]:
    """Answer one customer question. Returns the answer and the trace id.

    ``trace`` lets a caller put the agent's spans in a trace it already owns, which is
    how a local experiment links each example to the agent run it produced.
    """
    rendered = await hub.prompts.render(PROMPT, "production", {"question": question, "today": TODAY})
    result = await hub.gateway.run_prompt_with_tools(
        rendered,
        tools=[search_policies, lookup_order],
        trace={"name": PROMPT, **(trace or {})},
    )
    return result.content, result.trace_id


async def main() -> None:
    questions = sys.argv[1:] or json.loads((DATA / "questions.json").read_text())
    async with AcruxCore() as hub:
        for question in questions:
            answer, trace_id = await ask(hub, question)
            print(f"\nQ: {question}\nA: {answer}\n   trace {trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
