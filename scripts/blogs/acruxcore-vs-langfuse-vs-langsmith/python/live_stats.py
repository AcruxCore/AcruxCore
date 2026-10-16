"""Step 9: latency and cost per trace for the live run, read back from each platform's API.

Reads the root traces named scope-check that started inside one time window, so every platform
is measured the same way: latency is the root trace's end minus its start, cost is the cost the
platform stored for the trace.

    pip install httpx python-dotenv
    env: ACRUXCORE_API_KEY, ACRUXCORE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST,
         LANGSMITH_API_KEY, LANGSMITH_ENDPOINT

    python live_stats.py --since 2026-10-17T10:00:00Z --until 2026-10-17T10:15:00Z
"""

import argparse
import os
import statistics
from datetime import datetime

import httpx
from dotenv import load_dotenv

load_dotenv()
NAME = "scope-check"


def _ts(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def acruxcore(since: str, until: str) -> list[dict]:
    client = httpx.Client(base_url=os.environ["ACRUXCORE_BASE_URL"], timeout=60,
                          headers={"Authorization": f"Bearer {os.environ['ACRUXCORE_API_KEY']}"})
    rows, page = [], 1
    while True:
        body = client.get("/traces", params={"from": since, "to": until, "limit": 100, "page": page}).json()
        rows += body["data"]
        if len(body["data"]) < 100:
            break
        page += 1
    return [{"latency": _ts(t["endedAt"]) - _ts(t["startedAt"]), "cost": t.get("totalCostUsd"),
             "spans": t.get("spanCount")} for t in rows if t.get("name") == NAME and t.get("endedAt")]


def langfuse(since: str, until: str) -> list[dict]:
    client = httpx.Client(base_url=os.environ["LANGFUSE_HOST"], timeout=60,
                          auth=(os.environ["LANGFUSE_PUBLIC_KEY"], os.environ["LANGFUSE_SECRET_KEY"]))
    rows, page = [], 1
    while True:
        body = client.get("/api/public/traces", params={
            "name": NAME, "fromTimestamp": since, "toTimestamp": until, "limit": 100, "page": page}).json()
        rows += body["data"]
        if page >= body["meta"]["totalPages"]:
            break
        page += 1
    return [{"latency": t["latency"], "cost": t.get("totalCost"), "spans": len(t.get("observations", []))}
            for t in rows]


def langsmith(since: str, until: str) -> list[dict]:
    client = httpx.Client(base_url=os.environ.get("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com"),
                          timeout=60, headers={"x-api-key": os.environ["LANGSMITH_API_KEY"]})
    project = client.get("/api/v1/sessions", params={"name": NAME}).json()[0]["id"]
    rows, cursor = [], None
    while True:
        body = client.post("/api/v1/runs/query", json={
            "session": [project], "is_root": True, "start_time": since, "limit": 100, "cursor": cursor,
            "select": ["name", "start_time", "end_time", "total_cost"]}).json()
        rows += [r for r in body["runs"] if r["start_time"] < until.rstrip("Z")]
        cursor = (body.get("cursors") or {}).get("next")
        if not cursor:
            break
    return [{"latency": _ts(r["end_time"] + "Z") - _ts(r["start_time"] + "Z"),
             "cost": float(r["total_cost"]) if r.get("total_cost") is not None else None, "spans": None}
            for r in rows if r["name"] == NAME and r.get("end_time")]


def summary(rows: list[dict]) -> dict:
    latency = sorted(r["latency"] for r in rows)
    costs = [r["cost"] for r in rows if r["cost"] is not None]
    # p95 is the value at position int(0.95 * n), the 28th of 30: the rule the Langfuse vs LangSmith post used
    pct = lambda p: latency[max(0, int(p * len(latency)) - 1)]
    spans = [r["spans"] for r in rows if r["spans"] is not None]
    return {"traces": len(rows), "p50_s": round(statistics.median(latency), 2), "p95_s": round(pct(0.95), 2),
            "max_s": round(latency[-1], 2), "cost_mean": round(statistics.mean(costs), 6) if costs else None,
            "cost_sum": round(sum(costs), 6), "without_cost": len(rows) - len(costs),
            "spans_mean": round(statistics.mean(spans), 2) if spans else None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", required=True)
    parser.add_argument("--platforms", default="acruxcore,langfuse,langsmith")
    a = parser.parse_args()
    readers = {"acruxcore": acruxcore, "langfuse": langfuse, "langsmith": langsmith}
    for name in a.platforms.split(","):
        print(name, summary(readers[name](a.since, a.until)))
