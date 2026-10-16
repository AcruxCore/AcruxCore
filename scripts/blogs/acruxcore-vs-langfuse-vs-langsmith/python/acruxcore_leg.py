"""AcruxCore leg: the same scope-check app, traced and evaluated with AcruxCore.

The model calls go straight to z.ai, as in the Langfuse and LangSmith legs. AcruxCore receives
the spans afterwards through POST /traces, and prices them with the team's model price, cached
input tokens at the model's cached input price.

    pip install openai httpx python-dotenv
    env: ACRUXCORE_API_KEY, ACRUXCORE_BASE_URL (https://acruxcore.com/api/v1), ZAI_API_KEY

    python acruxcore_leg.py push-prompts --version 1
    python acruxcore_leg.py push-dataset
    python acruxcore_leg.py run --id msg-06
    python acruxcore_leg.py experiment --name v1
    python acruxcore_leg.py push-prompts --version 2 --names scope-extract,scope-classify
    python acruxcore_leg.py experiment --alias candidate --only scope-extract,scope-classify --name v2
    python acruxcore_leg.py live
    python acruxcore_leg.py gateway-check
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import API_KEY, BASE_URL, MODEL, PROMPT_NAMES, load_messages, load_prompt_file
from pipeline import build_app
from scoring import items_exact, judge_reply, total_exact

ACX_BASE_URL = os.getenv("ACRUXCORE_BASE_URL")
ACX_KEY = os.getenv("ACRUXCORE_API_KEY")
if not ACX_BASE_URL or not ACX_KEY or not API_KEY:
    sys.exit("Set ACRUXCORE_BASE_URL, ACRUXCORE_API_KEY and ZAI_API_KEY.")

# --- instrumentation: everything AcruxCore-specific the app needs -------------------------
import contextvars, functools, inspect, threading, uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
from openai import OpenAI

acx = httpx.Client(base_url=ACX_BASE_URL, headers={"Authorization": f"Bearer {ACX_KEY}"}, timeout=60)
zai = OpenAI(api_key=API_KEY, base_url=BASE_URL, max_retries=5, timeout=180)
_trace = contextvars.ContextVar("trace", default=None)    # (trace_id, spans) of the running trace
_parent = contextvars.ContextVar("parent", default=None)  # span id of the running step
last = threading.local()                                  # last.trace_id after each finished trace


def _now():
    return datetime.now(timezone.utc).isoformat()


def _create(*, acx_prompt_version=None, **kwargs):  # an OpenAI call that records an llm span
    start, response = _now(), zai.chat.completions.create(**kwargs)
    usage = response.usage
    _trace.get()[1].append({
        "spanId": str(uuid.uuid4()), "parentSpanId": _parent.get(), "name": kwargs["model"], "kind": "llm",
        "startTime": start, "endTime": _now(), "model": kwargs["model"], "promptVersionId": acx_prompt_version,
        "usage": {"promptTokens": usage.prompt_tokens, "completionTokens": usage.completion_tokens,
                  "totalTokens": usage.total_tokens,
                  "cachedTokens": getattr(usage.prompt_tokens_details, "cached_tokens", 0) or 0},
        "input": {"messages": kwargs["messages"]}, "output": response.choices[0].message.content})
    return response


client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_create)))
_cache = {}


def prompt_version(name: str, alias: str) -> dict:  # cached 60 s, like the Langfuse SDK default
    hit = _cache.get((name, alias))
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    prompt = next(p for p in acx.get("/prompts", params={"limit": 100}).json()["data"] if p["name"] == name)
    aliases = acx.get(f"/prompts/{prompt['id']}/aliases").json()
    version_id = next(a for a in aliases if a["alias"] == alias)["versionId"]
    version = {"id": version_id, **acx.get(f"/prompt-versions/{version_id}").json()}
    _cache[(name, alias)] = (time.time(), version)
    return version


def step(name: str, kind: str):
    def decorate(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            root = _trace.get() is None
            trace_token = _trace.set((str(uuid.uuid4()), [])) if root else None
            span = {"spanId": str(uuid.uuid4()), "parentSpanId": _parent.get(), "name": name, "kind": kind,
                    "startTime": _now(), "status": "ok",
                    "input": dict(inspect.signature(fn).bind(*args, **kwargs).arguments)}
            parent_token = _parent.set(span["spanId"])
            try:
                span["output"] = fn(*args, **kwargs)
                return span["output"]
            except Exception as error:
                span.update(status="error", error=repr(error))
                raise
            finally:
                _parent.reset(parent_token)
                trace_id, spans = _trace.get()
                spans.append({**span, "endTime": _now()})
                if root:
                    _trace.reset(trace_token)
                    spans = [{k: v for k, v in s.items() if v is not None} for s in spans]  # no nulls
                    acx.post("/traces", json={"traces": [{"traceId": trace_id, "name": name, "spans": spans}]}
                             ).raise_for_status()
                    last.trace_id = trace_id
        return wrapper
    return decorate


def make_app(alias: str = "production", only: set[str] | None = None):
    def get_prompt(name: str):  # `only` limits `alias` to some prompts; the rest stay on production
        version = prompt_version(name, alias if not only or name in only else "production")
        return version["messages"], {"acx_prompt_version": version["id"]}  # links the call to the version

    return build_app(get_prompt, client, step)
# --- end instrumentation -------------------------------------------------------------------

DATASET = "scope-check-expected"
RECORDS = Path(os.getenv("SCOPE_RECORDS") or Path(__file__).resolve().parent.parent / "records")


def _ok(response: httpx.Response) -> dict:
    if response.status_code >= 400:
        sys.exit(f"{response.request.method} {response.request.url} -> {response.status_code} {response.text}")
    return response.json() if response.content else {}


def _prompt_id(name: str) -> str | None:
    return next((p["id"] for p in _ok(acx.get("/prompts", params={"limit": 100}))["data"] if p["name"] == name),
                None)


def push_prompts(version: int, names: list[str]):
    """Commit prompts/<name>.v<N>.json as a new version. The first commit points production at it."""
    for name in names:
        prompt_id = _prompt_id(name) or _ok(acx.post("/prompts", json={
            "name": name, "description": f"Scope-check app: {name}"}))["id"]
        created = _ok(acx.post(f"/prompts/{prompt_id}/versions", json={
            "messages": load_prompt_file(name, version),
            "commit_message": f"v{version} from prompts/{name}.v{version}.json"}))
        aliases = _ok(acx.get(f"/prompts/{prompt_id}/aliases"))
        print(name, "-> AcruxCore version", created.get("versionNumber", created.get("version_number")),
              "aliases", {a["alias"]: a.get("versionNumber") for a in aliases})


def promote(names: list[str], alias: str, version: int):
    for name in names:
        result = _ok(acx.post(f"/prompts/{_prompt_id(name)}/aliases/{alias}/promote",
                              json={"version_number": version}))
        print(name, alias, "->", result.get("versionNumber", result))


def push_dataset():
    """One example per message. `input` holds the app's two inputs; `expected` holds the labels."""
    started = time.time()
    dataset = _ok(acx.post("/datasets", json={"name": DATASET}))
    examples = [{"input": m["input"], "expected": {"message_id": m["id"], **m["expected"]}}
                for m in load_messages()]
    result = _ok(acx.post(f"/datasets/{dataset['id']}/examples/bulk", json={"examples": examples}))
    print("dataset", dataset["id"], "added", result, "seconds", round(time.time() - started, 1))


def run_one(message_id: str):
    message = next(m for m in load_messages() if m["id"] == message_id)
    started = time.time()
    result = make_app()(**message["input"])
    print(json.dumps({"seconds": round(time.time() - started, 1), "trace_id": last.trace_id, **result}, indent=1))


def experiment(alias: str, name: str, concurrency: int, only: set[str] | None):
    """A local experiment: this process runs the app and the scorers, AcruxCore stores the run.

    POST /experiments/local returns the dataset's examples; each result goes up with its trace id
    and three scores (0-100); POST /runs/:id/finish closes the run. The Python SDK's
    experiments.run_local makes the same three calls, but it is async.
    """
    app = make_app(alias, only)
    judge = prompt_version("scope-judge", "production")
    dataset_id = next(d["id"] for d in _ok(acx.get("/datasets"))["data"] if d["name"] == DATASET)
    started = time.time()
    created = _ok(acx.post("/experiments/local", json={
        "dataset_id": dataset_id, "name": name, "model": MODEL, "primary_score": "items_exact"}))
    run_id = created["run_id"]

    def one(example):
        expected, item_started = example["expected"], time.time()
        try:
            output = app(**example["input"])
        except Exception as error:  # a failed item counts as a failure on every score
            return {"example_id": example["id"], "message_id": expected["message_id"], "error": repr(error),
                    "seconds": round(time.time() - item_started, 1)}
        verdict = judge_reply(zai, judge["messages"], example["input"]["message"], expected, output["reply"])
        scores = {"items_exact": items_exact(output["items"], expected["items"]),
                  "total_exact": total_exact(output["total"], expected["total"]),
                  "reply_judge": verdict.get("verdict") == "PASS"}
        return {"example_id": example["id"], "message_id": expected["message_id"], "trace_id": last.trace_id,
                "seconds": round(time.time() - item_started, 1), "output": output,
                "scores": [{"name": k, "score": 100 if v else 0,
                            **({"reason": verdict.get("reason")} if k == "reply_judge" else {})}
                           for k, v in scores.items()]}

    with ThreadPoolExecutor(concurrency) as pool:
        rows = list(pool.map(one, created["examples"]))
    _ok(acx.post(f"/runs/{run_id}/results", json={"results": [
        {k: r[k] for k in ("example_id", "output", "trace_id", "error", "scores") if k in r} for r in rows]}))
    finished = _ok(acx.post(f"/runs/{run_id}/finish", json={}))
    wall = round(time.time() - started, 1)
    ok = [r for r in rows if "scores" in r]
    summary = {k: sum(s["score"] == 100 for r in ok for s in r["scores"] if s["name"] == k)
               for k in ("items_exact", "total_exact", "reply_judge")}
    report = {"name": name, "alias": alias, "only": sorted(only or []), "run_id": run_id,
              "status": finished.get("status"), "url": created.get("url"), "wall_seconds": wall,
              "errors": len(rows) - len(ok), "summary": summary, "rows": rows}
    RECORDS.mkdir(exist_ok=True)
    (RECORDS / f"acruxcore-experiment-{name}-results.json").write_text(json.dumps(report, indent=1))
    print(json.dumps({k: report[k] for k in ("name", "run_id", "status", "wall_seconds", "errors", "summary")},
                     indent=1))


def gateway_check():
    """One extract call through the AcruxCore gateway, with reasoning_effort="low" as in the app."""
    gateway = OpenAI(api_key=ACX_KEY, base_url=f"{ACX_BASE_URL}/gateway")
    messages = [{"role": "user", "content": "List the separate requests in: 'Can you add a FAQ page and fix the logo?'"}]
    for effort in ("low", None):
        extra = {"reasoning_effort": effort} if effort else {}
        raw = gateway.chat.completions.with_raw_response.create(model=MODEL, messages=messages, **extra)
        usage = raw.parse().usage
        print(json.dumps({"reasoning_effort": effort, "completion_tokens": usage.completion_tokens,
                          "reasoning_tokens": getattr(usage.completion_tokens_details, "reasoning_tokens", None),
                          "cost_usd": raw.headers.get("x-gateway-cost-usd"),
                          "ignored": raw.headers.get("x-gateway-params-ignored"),
                          "trace_id": raw.headers.get("x-gateway-trace-id")}))


def live(alias: str):
    app = make_app(alias)
    for m in load_messages():
        started = time.time()
        result = app(**m["input"])
        print(m["id"], round(time.time() - started, 1), "s total", result["total"], "trace", last.trace_id,
              flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("push-prompts"); p.add_argument("--version", type=int, default=1)
    p.add_argument("--names", help="comma-separated prompt names (default: all four)")
    p = sub.add_parser("promote"); p.add_argument("--names", required=True); p.add_argument("--alias", default="production")
    p.add_argument("--version", type=int, required=True)
    sub.add_parser("push-dataset")
    p = sub.add_parser("run"); p.add_argument("--id", default="msg-06")
    p = sub.add_parser("experiment"); p.add_argument("--alias", default="production"); p.add_argument("--name", required=True)
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--only", help="comma-separated prompts that use --alias; others use production")
    p = sub.add_parser("live"); p.add_argument("--alias", default="production")
    sub.add_parser("gateway-check")
    a = parser.parse_args()
    if a.cmd == "push-prompts": push_prompts(a.version, a.names.split(",") if a.names else PROMPT_NAMES)
    elif a.cmd == "promote": promote(a.names.split(","), a.alias, a.version)
    elif a.cmd == "push-dataset": push_dataset()
    elif a.cmd == "run": run_one(a.id)
    elif a.cmd == "experiment": experiment(a.alias, a.name, a.concurrency, set(a.only.split(",")) if a.only else None)
    elif a.cmd == "live": live(a.alias)
    elif a.cmd == "gateway-check": gateway_check()
