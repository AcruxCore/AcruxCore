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
                  "totalTokens": usage.total_tokens},
        "attributes": {"cached_tokens": getattr(usage.prompt_tokens_details, "cached_tokens", 0) or 0},
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
