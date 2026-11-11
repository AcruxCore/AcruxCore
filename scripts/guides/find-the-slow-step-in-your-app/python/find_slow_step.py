"""
Find the slow step in your app -- Python.

Runs the small support app from the "Find the slow step in your app" guide
(apps/docs/docs/guides/traces/find-the-slow-step-in-your-app.mdx):

  answer-question   agent      one trace per question
  ├─ retrieve-docs  retrieval  searches ../data/help-articles.json
  ├─ lookup-order   tool       reads ../data/orders.json; fails for an unknown order
  └─ support-model  llm        the gateway call that writes the answer

Then it reads the same numbers the dashboard's "By step (span name)" table
shows, slowest p95 first.

retrieve-docs sleeps 1.5-2.5 s to stand in for a slow vector-store query, so it
is the step the table points at.

Requires:
  pip install acruxcore

Env:
  ACRUXCORE_API_KEY   -- required
  ACRUXCORE_BASE_URL  -- defaults to https://api.acruxcore.com/api/v1 in the SDK
  ACRUXCORE_MODEL     -- a model registered under Gateway -> Models
                         (default: support-model)

Run:
  python find_slow_step.py
"""
import asyncio
import json
import os
import random
from pathlib import Path

from acruxcore import AcruxCore

DATA = Path(__file__).resolve().parent.parent / "data"
ARTICLES = json.loads((DATA / "help-articles.json").read_text())
ORDERS = json.loads((DATA / "orders.json").read_text())
QUESTIONS = json.loads((DATA / "questions.json").read_text())
MODEL = os.environ.get("ACRUXCORE_MODEL", "support-model")

hub = AcruxCore()


@hub.traces.step("retrieve-docs", kind="retrieval")
async def retrieve_docs(question: str) -> list:
    await asyncio.sleep(random.uniform(1.5, 2.5))  # stands in for a slow vector store
    words = set(question.lower().replace("?", "").split())
    scored = [(len(words & set(a["body"].lower().split())), a) for a in ARTICLES]
    return [a for score, a in sorted(scored, key=lambda s: -s[0])[:2] if score > 0]


@hub.traces.step("lookup-order", kind="tool")
async def lookup_order(order_id: str) -> dict:
    await asyncio.sleep(random.uniform(0.02, 0.06))
    if order_id not in ORDERS:
        raise KeyError(f"no order {order_id}")
    return ORDERS[order_id]


@hub.traces.step("answer-question", kind="agent")
async def answer_question(question: str, order_id: str) -> str:
    articles = await retrieve_docs(question)
    try:
        order = await lookup_order(order_id)
    except KeyError:
        order = None  # the span is still marked as an error
    context = "\n".join(f"- {a['title']}: {a['body']}" for a in articles)
    reply = await hub.gateway.chat(MODEL, [
        {"role": "system", "content": "Answer in one sentence, using only the help articles and order."},
        {"role": "user", "content": f"Help articles:\n{context}\n\nOrder: {order}\n\nQuestion: {question}"},
    ])
    return reply.content


async def main() -> None:
    async with hub:
        for q in QUESTIONS:
            answer = await answer_question(q["question"], q["order_id"])
            print(f"{q['order_id']}  {q['question']}\n          {answer}")

        # Each trace is sent when its outermost step ends, in the background.
        await hub.traces.flush()

        result = await hub.traces.analytics(group_by="span_name")
        print(f"\n{'step':<18}{'calls':>6}{'failed':>8}{'p50 ms':>8}{'p95 ms':>8}")
        for b in sorted(result.buckets, key=lambda b: -b.latency_ms.p95):
            print(f"{b.key:<18}{b.requests:>6}{round(b.error_rate * b.requests):>8}"
                  f"{round(b.latency_ms.p50):>8}{round(b.latency_ms.p95):>8}")


if __name__ == "__main__":
    asyncio.run(main())
