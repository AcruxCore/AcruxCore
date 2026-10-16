"""Export one Langfuse dataset run's per-item results to JSON (for the run log)."""
import json
import sys

from langfuse import get_client

import common  # noqa: F401  (loads .env)

run_name, out = sys.argv[1], sys.argv[2]
langfuse = get_client()
run = langfuse.api.datasets.get_run("scope-check", run_name)
items = {i.id: i for i in langfuse.api.dataset_items.list(dataset_name="scope-check", limit=100).data}
rows = []
for run_item in run.dataset_run_items:
    trace = langfuse.api.trace.get(run_item.trace_id)
    item = items.get(run_item.dataset_item_id)
    scores = {s.name: {"value": s.value, "comment": s.comment} for s in trace.scores}
    rows.append({"message_id": (item.metadata or {}).get("message_id") if item else None,
                 "trace_id": run_item.trace_id, "seconds": trace.latency, "total_cost": trace.total_cost,
                 "scores": scores, "output": trace.output, "expected": item.expected_output if item else None})
rows.sort(key=lambda r: r["message_id"] or "")
json.dump({"run": run_name, "run_id": run.id, "rows": rows}, open(out, "w"), indent=1, default=str)
for k in ("items_exact", "total_exact", "reply_judge"):
    vals = [r["scores"].get(k, {}).get("value") for r in rows]
    print(k, sum(v for v in vals if v is not None), "/", len(vals), "missing", sum(v is None for v in vals))
lat = sorted(r["seconds"] or 0 for r in rows)
print("items", len(rows), "p50", lat[len(lat) // 2] if lat else None, "max", lat[-1] if lat else None)
