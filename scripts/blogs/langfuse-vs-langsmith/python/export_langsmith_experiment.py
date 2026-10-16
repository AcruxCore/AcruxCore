"""Export one LangSmith experiment's per-example results to JSON (for the run log)."""
import json, sys
from langsmith import Client
import common  # noqa: F401  (loads .env)

name = sys.argv[1]; out = sys.argv[2]
c = Client()
project = c.read_project(project_name=name, include_stats=True)
rows = []
for run in c.list_runs(project_id=project.id, is_root=True):
    fb = {f.key: {"score": f.score, "comment": f.comment} for f in c.list_feedback(run_ids=[run.id])}
    ex = c.read_example(run.reference_example_id) if run.reference_example_id else None
    rows.append({"message_id": (ex.metadata or {}).get("message_id") if ex else None, "run_id": str(run.id),
                 "trace_id": str(run.trace_id), "seconds": (run.end_time - run.start_time).total_seconds(),
                 "total_tokens": run.total_tokens, "error": run.error, "feedback": fb,
                 "output": run.outputs, "expected": ex.outputs if ex else None})
rows.sort(key=lambda r: r["message_id"] or "")
stats = {k: getattr(project, k, None) for k in ("run_count", "latency_p50", "latency_p99", "total_tokens", "total_cost", "feedback_stats")}
json.dump({"experiment": name, "project_id": str(project.id), "stats": stats, "rows": rows}, open(out, "w"), indent=1, default=str)
for k in ("items_exact", "total_exact", "reply_judge"):
    vals = [r["feedback"].get(k, {}).get("score") for r in rows]
    print(k, sum(v for v in vals if v is not None), "/", len(vals))
print("errors", sum(1 for r in rows if r["error"]), "stats", {k: stats[k] for k in ("run_count", "latency_p50", "latency_p99", "total_tokens", "total_cost")})
