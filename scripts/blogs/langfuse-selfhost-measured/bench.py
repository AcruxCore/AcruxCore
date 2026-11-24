"""Benchmark one self-hosted LLM observability stack end to end.

  python bench.py full <tool>          boot x3, idle, 10k ingest, 100k ingest, queries
  python bench.py cap  <tool> <gb> <cpus>   fresh stack inside a memory+CPU cap, 10k ingest

Tools: langfuse, phoenix, mlflow, opik, acrux. Compose commands live in compose.sh.
Every reading is appended to results/<project>.jsonl as one JSON line.

What each phase measures:
- boot: seconds from `compose up -d` (images already pulled, empty volumes) until the
  tool's health URL answers 2xx. Three runs, `down -v` between them.
- ingest: 4 sender processes push traces over OTLP/HTTP with backpressure (load.py).
  `accept_s` is until the last batch was accepted; `visible_s` is until the tool's own
  database holds every trace (some tools queue writes). Peak memory and CPU come from
  `docker stats` sampled throughout.
- settle: memory and disk after the tool has been idle for SETTLE_MIN minutes.
- query: median and p95 of 30 timed calls after 5 warm-ups, for "latest 50 traces" and
  "one trace with its spans", through each tool's public HTTP API.
- cap: the whole stack runs in a systemd slice limited by memory.max (swap 0) and cpu.max,
  which is how a small VPS behaves. Records whether it boots, ingests 10k traces,
  and whether the kernel killed anything for lack of memory.
"""
import base64
import json
import re
import os
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
RESULTS = HERE / "results"
SETTLE_MIN = int(os.environ.get("SETTLE_MIN", "10"))
IDLE_MIN = int(os.environ.get("IDLE_MIN", "3"))
LF_AUTH = "Basic " + base64.b64encode(b"pk-lf-bench:sk-lf-bench").decode()
PHX_AUTH = "Bearer benchadmin0001benchadmin0001benchadmin00"


def sh(*cmd: str, check: bool = True, timeout: float | None = None) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd} failed: {r.stderr[-800:]}")
    return r.stdout


def compose(tool: str, project: str, *args: str, cap_file: str | None = None, check: bool = True) -> str:
    env = {**os.environ}
    if cap_file:
        env["CAP_FILE"] = cap_file
    r = subprocess.run([str(HERE / "compose.sh"), tool, project, *args], capture_output=True, text=True, env=env)
    with open(RESULTS / f"{project}.compose.log", "a") as f:
        f.write(f"$ compose {' '.join(args)}\n{r.stdout}{r.stderr}\n")
    if check and r.returncode != 0:
        raise RuntimeError(f"compose {args} failed: {r.stderr[-800:]}")
    return r.stdout


def record(project: str, row: dict) -> None:
    row = {"project": project, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **row}
    with open(RESULTS / f"{project}.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")
    print(json.dumps(row), flush=True)


def http(url: str, headers: dict | None = None, body: dict | None = None, timeout: float = 60) -> tuple[int, bytes]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={**(headers or {}), **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception:
        return 0, b""


def wait_ready(url: str, limit: float, headers: dict | None = None) -> float | None:
    t0 = time.time()
    while time.time() - t0 < limit:
        code, _ = http(url, headers, timeout=3)
        if 200 <= code < 400:
            return round(time.time() - t0, 1)
        time.sleep(1)
    return None


# ---------------------------------------------------------------- per-tool adapters

def ch(container: str, q: str, *auth: str) -> str:
    return sh("docker", "exec", container, "clickhouse-client", *auth, "-q", q, timeout=120).strip()


def psql(container: str, user: str, db: str, q: str) -> str:
    return sh("docker", "exec", container, "psql", "-U", user, "-d", db, "-tAc", q, timeout=120).strip()


class Tool:
    ready = ""
    otlp = ""

    def __init__(self, project: str) -> None:
        self.p = project
        self.headers: dict[str, str] = {}

    def setup(self) -> None:
        """Create whatever credentials the sender and the queries need."""

    def count(self) -> int:
        raise NotImplementedError

    def q_list(self) -> tuple[str, dict, dict | None]:
        raise NotImplementedError

    def q_get(self, list_body: bytes) -> tuple[str, dict, dict | None]:
        raise NotImplementedError


class Langfuse(Tool):
    ready = "http://localhost:43000/api/public/health"
    otlp = "http://localhost:43000/api/public/otel/v1/traces"

    def setup(self) -> None:
        self.headers = {"Authorization": LF_AUTH}

    def count(self) -> int:
        return int(ch(f"{self.p}-clickhouse-1",
                      "select uniqExact(trace_id) from events_full where project_id='bench-project'",
                      "--user", "clickhouse", "--password", "clickhouse") or 0)

    def q_list(self):
        # Langfuse v4 (events_only) removed GET /api/public/traces; root observations are the traces.
        return "http://localhost:43000/api/public/v2/observations?limit=50&name=agent-run", self.headers, None

    def q_get(self, b):
        tid = json.loads(b)["data"][0]["traceId"]
        return f"http://localhost:43000/api/public/v2/observations?traceId={tid}", self.headers, None


class Phoenix(Tool):
    ready = "http://localhost:46006/healthz"
    otlp = "http://localhost:46006/v1/traces"

    def setup(self) -> None:
        self.headers = {"Authorization": PHX_AUTH}

    def count(self) -> int:
        return int(psql(f"{self.p}-db-1", "postgres", "postgres", "select count(*) from traces") or 0)

    def q_list(self):
        return "http://localhost:46006/v1/projects/default/traces?limit=50", self.headers, None

    def q_get(self, b):
        tid = json.loads(b)["data"][0]["trace_id"]
        return f"http://localhost:46006/v1/projects/default/spans?trace_id={tid}&limit=100", self.headers, None


class MLflow(Tool):
    ready = "http://localhost:45000/health"
    otlp = "http://localhost:45000/v1/traces"

    def setup(self) -> None:
        self.headers = {"x-mlflow-experiment-id": "0"}

    def count(self) -> int:
        return int(psql(f"{self.p}-postgres-1", "mlflow", "mlflow", "select count(*) from trace_info") or 0)

    def q_list(self):
        return ("http://localhost:45000/api/3.0/mlflow/traces/search", {},
                {"locations": [{"type": "MLFLOW_EXPERIMENT", "mlflow_experiment": {"experiment_id": "0"}}],
                 "max_results": 50})

    def q_get(self, b):
        tid = json.loads(b)["traces"][0]["trace_id"]
        # What the MLflow UI calls to show a trace's spans.
        return f"http://localhost:45000/ajax-api/3.0/mlflow/get-trace-artifact?request_id={tid}", {}, None


class Opik(Tool):
    ready = "http://localhost:45173/api/is-alive/ping"
    otlp = "http://localhost:45173/api/v1/private/otel/v1/traces"

    def setup(self) -> None:
        self.headers = {"projectName": "bench"}

    def count(self) -> int:
        try:
            pid = sh("docker", "exec", f"{self.p}-mysql-1", "mysql", "-uopik", "-popik", "opik", "-Ne",
                     "select id from projects where name='bench'", timeout=60).strip()
        except RuntimeError:
            return 0
        if not pid:
            return 0
        return int(ch(f"{self.p}-clickhouse-1", f"select count() from opik.traces final where project_id='{pid}'") or 0)

    def q_list(self):
        return "http://localhost:45173/api/v1/private/traces?project_name=bench&size=50", {}, None

    def q_get(self, b):
        tid = json.loads(b)["content"][0]["id"]
        return f"http://localhost:45173/api/v1/private/spans?project_name=bench&trace_id={tid}", {}, None


class Acrux(Tool):
    ready = "http://localhost:43001/api/v1/health"
    otlp = "http://localhost:43001/api/v1/traces/otlp"

    def setup(self) -> None:
        api = "http://localhost:43001/api/v1"
        hdr = {"Content-Type": "application/json", "Origin": "http://localhost:8080"}
        req = urllib.request.Request(f"{api}/auth/sign-up/email", data=json.dumps(
            {"email": "bench@example.com", "password": "bench-password-0001", "name": "Bench"}).encode(), headers=hdr)
        with urllib.request.urlopen(req, timeout=60) as r:
            cookie = next(v.split(";")[0] for k, v in r.getheaders() if k.lower() == "set-cookie" and "session_token" in v)
        req = urllib.request.Request(f"{api}/api-keys", data=b'{"name":"bench"}', headers={**hdr, "Cookie": cookie})
        with urllib.request.urlopen(req, timeout=60) as r:
            key = json.load(r)["key"]
        self.headers = {"Authorization": f"Bearer {key}"}

    def count(self) -> int:
        return int(psql(f"{self.p}-postgres-1", "acruxcore", "acruxcore", "select count(*) from traces") or 0)

    def q_list(self):
        return "http://localhost:43001/api/v1/traces?limit=50", self.headers, None

    def q_get(self, b):
        tid = json.loads(b)["data"][0]["id"]
        return f"http://localhost:43001/api/v1/traces/{tid}", self.headers, None


TOOLS = {"langfuse": Langfuse, "phoenix": Phoenix, "mlflow": MLflow, "opik": Opik, "acrux": Acrux}


# ---------------------------------------------------------------- measurements

def containers(project: str) -> list[str]:
    return sh("docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}").split()


class Sampler(threading.Thread):
    """Poll `docker stats` until stopped; keep every total so peaks and medians can be reported."""

    def __init__(self, project: str) -> None:
        super().__init__(daemon=True)
        self.project, self.stop_flag, self.rows = project, threading.Event(), []

    def run(self) -> None:
        sys.path.insert(0, str(HERE))
        from measure import to_bytes
        while not self.stop_flag.is_set():
            ids = containers(self.project)
            if not ids:
                time.sleep(2)
                continue
            out = sh("docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}", *ids, check=False)
            per = {}
            for line in out.strip().splitlines():
                try:
                    n, mem, cpu = line.split("\t")
                    per[n] = (to_bytes(mem.split("/")[0]) / 1024**2, float(cpu.rstrip("%")))
                except ValueError:
                    continue
            if per:
                self.rows.append({"t": round(time.time(), 1),
                                  "mib": round(sum(v[0] for v in per.values())),
                                  "cpu": round(sum(v[1] for v in per.values()), 1),
                                  "top": max(per.items(), key=lambda kv: kv[1][0])[0]})

    def summary(self) -> dict:
        self.stop_flag.set()
        self.join(timeout=30)
        if not self.rows:
            return {}
        peak = max(self.rows, key=lambda r: r["mib"])
        return {"peak_mib": peak["mib"], "peak_mib_top_container": peak["top"],
                "peak_cpu_pct": max(r["cpu"] for r in self.rows),
                "median_cpu_pct": statistics.median(r["cpu"] for r in self.rows),
                "samples": len(self.rows)}


def ingest(tool: Tool, label: str, traces: int, offset: int, visible_limit: float = 1800) -> dict:
    before = tool.count()
    sampler = Sampler(tool.p)
    sampler.start()
    t0 = time.time()
    args = [sys.executable, str(HERE / "load.py"), "--endpoint", tool.otlp, "--traces", str(traces),
            "--workers", "4", "--offset", str(offset)]
    for k, v in tool.headers.items():
        args += ["--header", f"{k}={v}"]
    r = subprocess.run(args, capture_output=True, text=True, timeout=7200)
    accept_s = round(time.time() - t0, 1)
    sender = next((json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")), {"error": r.stderr[-600:]})
    target, n = before + traces, before
    if "error" in sender:  # the sender gave up (server down or rejecting); don't wait the full limit
        visible_limit = min(visible_limit, accept_s + 120)
    while time.time() - t0 < visible_limit:
        try:
            n = tool.count()
        except Exception:
            pass
        if n >= target:
            break
        time.sleep(2)
    visible_s = round(time.time() - t0, 1) if n >= target else None
    row = {"kind": "ingest", "label": label, "traces": traces, "accept_s": accept_s, "visible_s": visible_s,
           "stored_after": n, "expected": target, "sender": sender, **sampler.summary()}
    with open(RESULTS / f"{tool.p}.samples.jsonl", "a") as f:
        f.write(json.dumps({"label": label, "rows": sampler.rows}) + "\n")
    record(tool.p, row)
    return row


SPACE_SQL_CH = ("select database, round(sum(bytes_on_disk)/1048576,1) from system.parts where active "
                "group by database order by 2 desc format TSV")
SPACE_SQL_PG = ("select relname, round(pg_total_relation_size(c.oid)/1048576.0,1) from pg_class c "
                "join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname not in "
                "('pg_catalog','information_schema') union all select '_wal', round(sum(size)/1048576.0,1) "
                "from pg_ls_waldir() order by 2 desc limit 7")


def space(tool: Tool) -> dict:
    """Where the bytes are: ClickHouse per database (trace data vs system logs) or the largest Postgres tables."""
    name = type(tool).__name__
    try:
        if name == "Langfuse":
            out = ch(f"{tool.p}-clickhouse-1", SPACE_SQL_CH, "--user", "clickhouse", "--password", "clickhouse")
        elif name == "Opik":
            out = ch(f"{tool.p}-clickhouse-1", SPACE_SQL_CH)
        elif name == "Phoenix":
            out = psql(f"{tool.p}-db-1", "postgres", "postgres", SPACE_SQL_PG)
        elif name == "MLflow":
            out = psql(f"{tool.p}-postgres-1", "mlflow", "mlflow", SPACE_SQL_PG)
        else:
            out = psql(f"{tool.p}-postgres-1", "acruxcore", "acruxcore", SPACE_SQL_PG)
    except Exception as e:
        return {"error": str(e)[-300:]}
    result = {}
    for line in out.splitlines():
        parts = re.split(r"[\t|]", line.strip())
        if len(parts) == 2:
            result[parts[0]] = float(parts[1])
    return result


def snapshot(tool: Tool, label: str) -> None:
    py = sys.executable
    record(tool.p, {"kind": "space", "label": label, "mib": space(tool)})
    sh(py, str(HERE / "measure.py"), "memory", tool.p, label, "--samples", "6", "--interval", "5")
    sh(py, str(HERE / "measure.py"), "disk", tool.p, label)
    try:
        n = tool.count()
    except Exception as e:
        n = f"error: {e}"
    record(tool.p, {"kind": "count", "label": label, "stored": n})


def timed(url: str, headers: dict, body: dict | None, n: int = 30) -> dict:
    for _ in range(5):
        http(url, headers, body)
    ts, sizes, codes = [], [], set()
    for _ in range(n):
        t0 = time.perf_counter()
        code, b = http(url, headers, body)
        ts.append((time.perf_counter() - t0) * 1000)
        codes.add(code)
        sizes.append(len(b))
    ts.sort()
    return {"median_ms": round(statistics.median(ts), 1), "p95_ms": round(ts[int(0.95 * (n - 1))], 1),
            "max_ms": round(ts[-1], 1), "bytes": int(statistics.median(sizes)), "codes": sorted(codes)}


def queries(tool: Tool, label: str) -> None:
    url, h, body = tool.q_list()
    code, b = http(url, h, body)
    row = {"kind": "query", "label": label, "list": {"url": url, **timed(url, h, body)}}
    if code == 200:
        gurl, gh, gbody = tool.q_get(b)
        row["get"] = {"url": gurl, **timed(gurl, gh, gbody)}
    record(tool.p, row)


def fresh_up(tool: Tool, name: str, cap_file: str | None = None, limit: float = 900) -> float | None:
    compose(name, tool.p, "down", "-v", "--remove-orphans", check=False)
    t0 = time.time()
    compose(name, tool.p, "up", "-d", cap_file=cap_file, check=False)
    # A host port freed by the previous stack can still be held for a moment ("address already
    # in use"), which leaves a container in Created with a broken network. Recreate it once.
    stuck = sh("docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={tool.p}",
               "--filter", "status=created").split()
    if stuck:
        record(tool.p, {"kind": "note", "msg": f"{len(stuck)} container(s) stuck in Created; recreated once"})
        time.sleep(5)
        compose(name, tool.p, "up", "-d", "--force-recreate", cap_file=cap_file, check=False)
    up_s = time.time() - t0
    r = wait_ready(tool.ready, limit - up_s)
    return None if r is None else round(up_s + r, 1)


def full(name: str) -> None:
    tool = TOOLS[name](f"lfm-{name}{os.environ.get('RUN_TAG', '')}")
    for i in (1, 2, 3):
        s = fresh_up(tool, name)
        record(tool.p, {"kind": "boot", "run": i, "ready_s": s})
    time.sleep(IDLE_MIN * 60)
    tool.setup()
    snapshot(tool, "idle")
    ingest(tool, "first_10k", 10_000, 0)
    time.sleep(SETTLE_MIN * 60)
    snapshot(tool, "settled_10k")
    queries(tool, "at_10k")
    ingest(tool, "next_90k", 90_000, 10_000, visible_limit=5400)
    time.sleep(SETTLE_MIN * 60)
    snapshot(tool, "settled_100k")
    queries(tool, "at_100k")
    sh(sys.executable, str(HERE / "measure.py"), "images", tool.p)
    if not os.environ.get("KEEP_UP"):  # KEEP_UP=1 leaves the stack running for follow-up queries
        compose(name, tool.p, "down", "-v", "--remove-orphans", check=False)
    record(tool.p, {"kind": "done"})


def write_cap_file(name: str, project: str, slice_: str, mem_gb: int, cpus: int) -> str:
    """Put every service in the slice (which caps the total) AND give each one a visible limit
    equal to the whole machine. On a real VPS every process sees the machine's RAM and CPUs, and
    runtimes size themselves from that: a JVM takes 1/4 of it for heap, ClickHouse 90%. Without
    the per-container limit they see the host's 62 GiB (checked: JVM "Memory Limit: Unlimited",
    ClickHouse max_server_memory_usage 56 GiB) and overcommit."""
    services = compose(name, project, "config", "--services").split()
    path = RESULTS / f"{project}.cap.yml"
    path.write_text("services:\n" + "".join(
        f"  {s}:\n    cgroup_parent: {slice_}\n    mem_limit: {mem_gb}g\n    memswap_limit: {mem_gb}g\n"
        f"    cpus: {cpus}\n" for s in services))
    return str(path)


def cgroup_set(slice_: str, mem_gb: int, cpus: int) -> str:
    script = (f"d=/sys/fs/cgroup/{slice_}; echo {mem_gb * 1024**3} > $d/memory.max; echo 0 > $d/memory.swap.max; "
              f"echo '{cpus * 100000} 100000' > $d/cpu.max; cat $d/memory.max $d/cpu.max")
    return sh("docker", "run", "--rm", "--privileged", "-v", "/sys/fs/cgroup:/sys/fs/cgroup", "alpine:3.20", "sh", "-c", script)


def cgroup_read(slice_: str) -> dict:
    out = sh("docker", "run", "--rm", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro", "alpine:3.20", "sh", "-c",
             f"d=/sys/fs/cgroup/{slice_}; cat $d/memory.events; echo peak_bytes $(cat $d/memory.peak); echo limit_bytes $(cat $d/memory.max)")
    return {k: v for k, v in (l.split() for l in out.strip().splitlines())}


def cap(name: str, mem_gb: int, cpus: int) -> None:
    # "-v2": per-container visible limits added (see write_cap_file); v1 files used the slice only.
    project = f"lfm-{name}-{mem_gb}g{os.environ.get('CAP_TAG', '-v2')}"
    tool = TOOLS[name](project)
    # One slice per run: a slice outlives its containers, and memory.events / memory.peak are
    # cumulative, so a reused slice reports the previous run's OOM kills and peak.
    slice_ = f"lfm{mem_gb}g{cpus}c{name}{int(time.time())}.slice"
    # A placeholder container keeps the slice alive so the limits exist before the stack starts.
    sh("docker", "rm", "-f", f"{slice_}-hold", check=False)
    sh("docker", "run", "-d", "--name", f"{slice_}-hold", "--cgroup-parent", slice_, "alpine:3.20", "sleep", "infinity")
    limits = cgroup_set(slice_, mem_gb, cpus).split()
    cap_file = write_cap_file(name, project, slice_, mem_gb, cpus)
    s = fresh_up(tool, name, cap_file=cap_file, limit=900)
    row = {"kind": "cap", "mem_gb": mem_gb, "cpus": cpus, "slice_limits": limits, "ready_s": s}
    if s is not None:
        time.sleep(60)
        try:
            tool.setup()
            ing = ingest(tool, f"cap_{mem_gb}g_10k", 10_000, 0, visible_limit=1800)
            row.update({"ingest_accept_s": ing["accept_s"], "ingest_visible_s": ing["visible_s"],
                        "stored": ing["stored_after"], "peak_mib": ing.get("peak_mib")})
            time.sleep(300)
            url, h, body = tool.q_list()
            row["list_query"] = timed(url, h, body, n=10)
        except Exception as e:  # a stack that dies under the cap is a result, not a crash
            row["error"] = str(e)[-600:]
    states = []
    for cid in sh("docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={project}").split():
        st = json.loads(sh("docker", "inspect", "-f", "{{json .State}}", cid))
        nm = sh("docker", "inspect", "-f", "{{.Name}}", cid).strip("/\n")
        rc = sh("docker", "inspect", "-f", "{{.RestartCount}}", cid).strip()
        states.append({"name": nm, "status": st["Status"], "oom_killed": st["OOMKilled"],
                       "exit": st["ExitCode"], "restarts": int(rc)})
    row["containers"] = states
    row["cgroup"] = cgroup_read(slice_)
    record(project, row)
    compose(name, project, "logs", "--no-color", "--tail", "200", check=False)
    compose(name, project, "down", "-v", "--remove-orphans", check=False)
    sh("docker", "rm", "-f", f"{slice_}-hold", check=False)


if __name__ == "__main__":
    RESULTS.mkdir(exist_ok=True)
    if sys.argv[1] == "full":
        full(sys.argv[2])
    elif sys.argv[1] == "cap":
        cap(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
