"""Print one summary row per tool from results/*.jsonl (latest record of each kind wins)."""
import json
from pathlib import Path

ORDER = ["shb-acrux", "shb-phoenix", "shb-lmnr", "shb-mlflow", "shb-langfuse2", "shb-langfuse", "shb-opik", "shb-agenta"]


def load(project: str) -> dict:
    out: dict = {}
    f = Path(__file__).parent / "results" / f"{project}.jsonl"
    if not f.exists():
        return out
    for line in f.read_text().splitlines():
        d = json.loads(line)
        out[(d["kind"], d.get("label", ""))] = d
    return out


def gib(mib):
    return f"{mib / 1024:.2f}" if mib is not None else "-"


print("| project | running/all containers | images GB | ready s | idle RAM GiB | after-load RAM GiB | settled RAM GiB | disk idle MiB | disk after MiB | disk settled MiB |")
print("|---|---|---|---|---|---|---|---|---|---|")
for p in ORDER:
    r = load(p)
    if not r:
        continue
    img = r.get(("images", ""), {})
    cs = r.get(("cold_start", ""), {})
    ready = (cs.get("compose_up_returned_s", 0) or 0) + (cs.get("ready_after_up_s", 0) or 0)

    def mem(label):
        return r.get(("memory", label), {}).get("total_mib")

    def disk(label):
        d = r.get(("disk", label))
        return round(d["volumes_total_mib"] + d["layers_total_mib"], 1) if d else "-"

    print(f"| {p} | {img.get('running_containers','-')}/{img.get('all_containers','-')} | {img.get('total_mb',0)/1000:.1f} | {ready:.0f} | "
          f"{gib(mem('idle'))} | {gib(mem('after_load'))} | {gib(mem('settled'))} | {disk('idle')} | {disk('after_load')} | {disk('settled')} |")
