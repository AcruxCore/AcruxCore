"""Measure the footprint of one running Docker Compose project.

  python measure.py images  <project>
  python measure.py memory  <project> <label> [--samples 12] [--interval 10]
  python measure.py disk    <project> <label>

Every command appends one JSON line to results/<project>.jsonl and prints it.
Memory is what `docker stats` reports (cgroup usage minus inactive file
cache), summed over the project's containers. The median of the samples is
kept, per container and in total.
"""
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

RESULTS = Path(__file__).parent / "results"
UNITS = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "kB": 1000, "MB": 1000**2, "GB": 1000**3}


def sh(*cmd: str) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def to_bytes(s: str) -> float:
    s = s.strip()
    for u in sorted(UNITS, key=len, reverse=True):
        if s.endswith(u):
            return float(s[: -len(u)]) * UNITS[u]
    return float(s)


def containers(project: str, all_: bool = False) -> list[str]:
    args = ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"]
    if all_:
        args.insert(2, "-a")
    return sh(*args).split()


def name_of(cid: str) -> str:
    return sh("docker", "inspect", "-f", "{{index .Config.Labels \"com.docker.compose.service\"}}", cid).strip()


def record(project: str, row: dict) -> None:
    RESULTS.mkdir(exist_ok=True)
    row = {"project": project, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **row}
    with open(RESULTS / f"{project}.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")
    print(json.dumps(row, indent=1))


def images(project: str) -> None:
    seen: dict[str, dict] = {}
    for cid in containers(project, all_=True):
        img_id = sh("docker", "inspect", "-f", "{{.Image}}", cid).strip()
        ref = sh("docker", "inspect", "-f", "{{.Config.Image}}", cid).strip()
        size = int(sh("docker", "image", "inspect", "-f", "{{.Size}}", img_id).strip())
        seen[img_id] = {"ref": ref, "mb": round(size / 1e6)}
    record(project, {
        "kind": "images",
        "running_containers": len(containers(project)),
        "all_containers": len(containers(project, all_=True)),
        "images": sorted(seen.values(), key=lambda r: -r["mb"]),
        "total_mb": sum(r["mb"] for r in seen.values()),
    })


def memory(project: str, label: str, samples: int, interval: int) -> None:
    ids = containers(project)
    names = {cid: name_of(cid) for cid in ids}
    mem: dict[str, list[float]] = {n: [] for n in names.values()}
    cpu: dict[str, list[float]] = {n: [] for n in names.values()}
    for i in range(samples):
        out = sh("docker", "stats", "--no-stream", "--format", "{{.ID}}\t{{.MemUsage}}\t{{.CPUPerc}}", *ids)
        for line in out.strip().splitlines():
            cid, usage, perc = line.split("\t")
            n = next(v for k, v in names.items() if k.startswith(cid) or cid.startswith(k[:12]))
            mem[n].append(to_bytes(usage.split("/")[0]) / 1024**2)
            cpu[n].append(float(perc.rstrip("%")))
        if i < samples - 1:
            time.sleep(interval)
    per = {n: {"mib": round(statistics.median(v)), "cpu_pct": round(statistics.median(cpu[n]), 1)} for n, v in mem.items()}
    record(project, {
        "kind": "memory", "label": label, "samples": samples,
        "per_container": dict(sorted(per.items(), key=lambda kv: -kv[1]["mib"])),
        "total_mib": sum(p["mib"] for p in per.values()),
        "total_cpu_pct": round(sum(p["cpu_pct"] for p in per.values()), 1),
    })


def disk(project: str, label: str) -> None:
    vols = sh("docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={project}").split()
    sizes = {}
    for v in vols:
        out = sh("docker", "run", "--rm", "-v", f"{v}:/v:ro", "alpine:3.20", "du", "-sk", "/v")
        sizes[v] = round(int(out.split()[0]) / 1024, 1)
    layers = {}
    out = sh("docker", "ps", "-a", "-s", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}\t{{.Size}}")
    for line in out.strip().splitlines():
        nm, sz = line.split("\t")
        layers[nm] = round(to_bytes(sz.split("(")[0]) / 1024**2, 1)
    record(project, {
        "kind": "disk", "label": label,
        "volumes_mib": sizes, "volumes_total_mib": round(sum(sizes.values()), 1),
        "writable_layers_mib": layers, "layers_total_mib": round(sum(layers.values()), 1),
    })


if __name__ == "__main__":
    cmd, project = sys.argv[1], sys.argv[2]
    if cmd == "images":
        images(project)
    elif cmd == "memory":
        args = sys.argv[3:]
        samples = int(args[args.index("--samples") + 1]) if "--samples" in args else 12
        interval = int(args[args.index("--interval") + 1]) if "--interval" in args else 10
        memory(project, args[0], samples, interval)
    elif cmd == "disk":
        disk(project, sys.argv[3])
