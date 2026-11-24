"""Print the article's tables from results/*.jsonl.

  python summarize.py

Full runs come from results/lfm-<tool>.jsonl, capped runs from results/lfm-<tool>-<gb>g-v2.jsonl.
AcruxCore uses its re-run on images built from staging 241f233, which holds the fix for issue #851
(files with the -851 suffix), released in 2026.11.9; the earlier AcruxCore files measured the published 2026.11.7 images.
Disk per 1,000 traces is (volumes at settled_100k - volumes at idle) / 100.
"""
import json
import statistics
from pathlib import Path

R = Path(__file__).parent / "results"
TOOLS = ["langfuse", "phoenix", "mlflow", "acrux", "opik"]
# The tag on each tool's result files (AcruxCore: the re-run after issue #851).
SUFFIX = {"acrux": "-851"}
NAMES = {"langfuse": "Langfuse", "phoenix": "Phoenix", "mlflow": "MLflow", "acrux": "AcruxCore", "opik": "Opik"}


def rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


def pick(rs: list[dict], kind: str, label: str | None = None) -> dict:
    for r in rs:
        if r.get("kind") == kind and (label is None or r.get("label") == label):
            return r
    return {}


def gib(mib) -> str:
    return "-" if mib in (None, "") else f"{mib / 1024:.2f}"


print("## Full runs\n")
print("| Tool | Boot s (3 runs) | Idle GiB | 10k: accept s / visible s / peak GiB | Settled 10k GiB "
      "| 90k: accept s / visible s / peak GiB | Settled 100k GiB | Disk idle→100k MiB | MiB per 1k traces "
      "| List 50 @100k ms (p50/p95) | Get 1 @100k ms (p50/p95) |")
print("|" + "---|" * 11)
for t in TOOLS:
    rs = rows(R / f"lfm-{t}{SUFFIX.get(t, '')}.jsonl")
    if not rs:
        continue
    boots = [r["ready_s"] for r in rs if r.get("kind") == "boot"]
    i10, i90 = pick(rs, "ingest", "first_10k"), pick(rs, "ingest", "next_90k")
    d0, d100 = pick(rs, "disk", "idle"), pick(rs, "disk", "settled_100k")
    q = pick(rs, "query", "at_100k")
    disk0 = d0.get("volumes_total_mib", 0) + d0.get("layers_total_mib", 0)
    disk1 = d100.get("volumes_total_mib", 0) + d100.get("layers_total_mib", 0) if d100 else None
    per1k = f"{(disk1 - disk0) / 100:.1f}" if disk1 is not None else "-"
    ing = lambda i: f"{i.get('accept_s', '-')} / {i.get('visible_s', '-')} / {gib(i.get('peak_mib'))}" if i else "-"
    qq = lambda k: f"{q[k]['median_ms']} / {q[k]['p95_ms']}" if q.get(k) else "-"
    print(f"| {NAMES[t]} | {', '.join(str(b) for b in boots)} (median {statistics.median(boots) if boots else '-'}) "
          f"| {gib(pick(rs, 'memory', 'idle').get('total_mib'))} | {ing(i10)} "
          f"| {gib(pick(rs, 'memory', 'settled_10k').get('total_mib'))} | {ing(i90)} "
          f"| {gib(pick(rs, 'memory', 'settled_100k').get('total_mib'))} | {disk0:.0f} → {disk1 if disk1 is None else round(disk1)} "
          f"| {per1k} | {qq('list')} | {qq('get')} |")

print("\n## Where the 100k-trace disk goes (per volume, MiB)\n")
for t in TOOLS:
    d = pick(rows(R / f"lfm-{t}{SUFFIX.get(t, '')}.jsonl"), "disk", "settled_100k")
    if d:
        print(f"- {NAMES[t]}: " + ", ".join(f"{k.split('_', 1)[1]} {v}" for k, v in d["volumes_mib"].items()))

# The first 2 GB runs shared one systemd slice, so their cgroup counters include the Langfuse
# run before them; the note rows in those files record the per-run delta (0 kills).
SHARED_SLICE = {("phoenix", 2)}

print("\n## Capped runs\n")
print("| Tool | Cap | Booted (s) | 10k stored | Accept s / visible s | Peak GiB (docker stats) | OOM kills | Restarts / exited |")
print("|---|---|---|---|---|---|---|---|")
for t in TOOLS:
    for gb in (2, 4, 8):
        r = pick(rows(R / f"lfm-{t}-{gb}g-v2{SUFFIX.get(t, '')}.jsonl"), "cap")
        if not r:
            continue
        cg = r.get("cgroup", {})
        restarts = sum(c["restarts"] for c in r["containers"])
        exited = [c["name"].split("-", 3)[-1].removeprefix("v2-").removeprefix("851-") for c in r["containers"] if c["status"] != "running" and c["exit"] != 0]
        print(f"| {NAMES[t]} | {gb} GB / {r['cpus']} CPU | {r.get('ready_s') or 'no (15 min)'} "
              f"| {r.get('stored', '-')} | {r.get('ingest_accept_s', '-')} / {r.get('ingest_visible_s', '-')} "
              f"| {gib(r.get('peak_mib'))} | {'0 (see note)' if (t, gb) in SHARED_SLICE else cg.get('oom_kill', '-')} "
              f"| {restarts} / {', '.join(exited) or 'none'} |")
