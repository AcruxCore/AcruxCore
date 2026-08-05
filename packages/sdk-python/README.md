# acruxcore (Python)

Async Python SDK for Acrux Core. Fetch rendered prompts at runtime, call the AI
gateway, run client-side tool loops, and report/read traces — full feature
parity with the [TypeScript SDK](https://www.npmjs.com/package/@acruxcoreai/sdk),
with a Pythonic `async`/`await` API.

## Installation

```bash
pip install acruxcore
```

Requires Python 3.9+. Depends only on [`httpx`](https://www.python-httpx.org/).

> **Using Node or TypeScript instead?** Install the JavaScript SDK from npm:
> `npm install @acruxcoreai/sdk` — see
> [`@acruxcoreai/sdk` on npm](https://www.npmjs.com/package/@acruxcoreai/sdk).

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Quickstart

```python
import asyncio
from acruxcore import AcruxCore

async def main():
    async with AcruxCore(
        api_key="...",                               # or env ACRUXCORE_API_KEY
        base_url="https://api.acruxcore.com/api/v1",  # or env ACRUXCORE_BASE_URL
    ) as hub:
        result = await hub.prompts.render("summarise-article", "production", {"article": "..."})
        print(result.messages)

asyncio.run(main())
```

`AcruxCore` owns an `httpx.AsyncClient`, so use it as an async context manager
(`async with`) or call `await hub.gateway.aclose()` when done. Create one instance at
startup and reuse it — the render cache is a process-wide singleton.

## Chat

`gateway.chat()` is a single, non-looping call to the gateway's OpenAI-compatible
`POST /gateway/chat/completions`. It routes to the right provider, prices the
call, and records a trace server-side.

```python
r = await hub.gateway.chat("gpt-4o-mini", [{"role": "user", "content": "Say hi in one word."}])
print(r.content)        # 'Hello!'
print(r.finish_reason)  # 'stop'
print(r.usage)          # ChatUsage(prompt_tokens=..., completion_tokens=..., total_tokens=...)
print(r.gateway)        # GatewayCallMeta(request_id=..., provider=..., cost_usd=..., cache=...)
```

Pass `tools=` / `tool_refs=` / `tool_choice=` just like the raw endpoint. If the
model calls a tool, `gateway.chat()` hands it back raw on `r.message["tool_calls"]` — it
never dispatches. Use `gateway.run_tool_loop()` for that.

## Streaming

Use `gateway.stream()` to get an async iterator of chunks:

```python
async for chunk in await hub.gateway.stream("gpt-4o-mini", messages):
    print(chunk.delta.get("content", ""), end="", flush=True)
    if chunk.finish_reason:
        print(f"\n(done: {chunk.finish_reason})")
```

Each `chunk` mirrors one `chat.completion.chunk` SSE frame (`id`, `model`,
`delta`, `finish_reason`); iteration ends when the gateway sends `data: [DONE]`.

## Tools

Decorate a function with `@acrux.tool` and hand it to the loop. The name, the
model-facing description and the parameter schema all come from the function, so
there is nothing to keep in sync by hand:

```python
import httpx
from acruxcore import AcruxCore, acrux

@acrux.tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. 'Lahore'.
    """
    async with httpx.AsyncClient() as http:
        res = await http.get(f"https://wttr.in/{city}", params={"format": "j1"})
    current = res.json()["current_condition"][0]
    return {"city": city, "temp_c": int(current["temp_C"])}


async with AcruxCore() as hub:
    result = await hub.gateway.run_tool_loop(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Should I run in Lahore this evening?"}],
        tools=[get_weather],
    )
    print(result.content)      # final assistant text
    print(result.messages)     # full transcript, incl. tool calls/results
    print(result.iterations)   # number of model round-trips
    print(result.trace_id)     # trace covering every round-trip + tool call
```

The decorator is pure: it attaches a spec to the function and returns it
unchanged, so `await get_weather(city="London")` still works in a test.

### What the decorator derives

These rules are the SDK's contract, so they are worth knowing exactly:

- **Name** — the function name.
- **Description** — the docstring's first paragraph. A function with no
  docstring sends **no** description, which leaves whatever your team wrote in
  the dashboard in place. Write one and code owns it: every sync overwrites the
  dashboard's text. Pick per tool which side owns the wording.
- **Parameter descriptions** — the `Args:` block, Google style.
- **Required** — every parameter without a default.
- **Supported hints** — `str`, `int`, `float`, `bool`, `list[T]`, `dict`,
  `Optional[T]`, `Literal[...]`, and `Enum` subclasses. Anything else raises
  `ToolSchemaError` at decoration time — at import, not mid-run.

`@acrux.tool(parameters={...})` is the escape hatch: pass a JSON Schema and the
derivation is skipped entirely.

```python
@acrux.tool(parameters={"type": "object", "properties": {"table": {"type": "string"}}, "required": ["table"]})
async def count_rows(table: str) -> dict:
    ...
```

On Python 3.9 a tool signature must spell an optional parameter `Optional[int]`
rather than `int | None`; the `X | Y` form in an annotation is 3.10+.

### The catalog round-trip

On the first call, `gateway.run_tool_loop` **syncs** each decorated tool into the Tool
Catalog and then passes it to the model as a `tool_refs` entry rather than as an
inline schema. So the schema the model sees is the one the catalog holds, the
dashboard shows a version history for a tool defined in code, and every `tool`
span records the exact version that ran. The sync is idempotent and cached per
process: an unchanged tool costs one request per process, a changed one commits
a new version and moves its alias. Pass `sync=False` when a deploy step already
synced them.

### Catalog tools you didn't decorate

A tool whose catalog version has an **`http` executor** needs no local code at
all. Name it in `tool_refs=` and the platform calls the endpoint, writes the
`tool` span with the real payloads, and hands the result back to the loop:

```python
result = await hub.gateway.run_tool_loop(
    model="gpt-4o-mini",
    messages=messages,
    tool_refs=[{"name": "search_orders", "alias": "production"}],
)
```

`dispatch` is still there, and is what you need for two cases: raw
OpenAI-shaped dicts passed as `tool_defs=`, and a `tool_refs` entry with a
`client` executor you have not decorated. Something has to run a `client` tool,
so if neither a decorated function nor `dispatch` can, the loop raises
`MISSING_DISPATCH` **before** the first model call — the failure costs no tokens.

```python
async def dispatch(name: str, args: dict):
    if name == "get_weather":
        return await fetch_weather_from_your_provider(args["city"])
    raise ValueError(f"Unknown tool: {name}")

result = await hub.gateway.run_tool_loop(
    model="gpt-4o-mini", messages=messages, tool_defs=raw_defs, dispatch=dispatch
)
```

Prompt-attached tools arrive this way too: `prompts.render()` returns
`RenderResult(messages, tools)` where `tools` are the version's attached catalog
tools in OpenAI shape — those go in `tool_defs=`.

### The loop's behaviour

`gateway.run_tool_loop()` stops when the model responds without calling a tool, or after
`max_iterations` round-trips (default 10; `result.stopped_at_limit` is `True`
then). When the model requests several tools in one turn they run
**concurrently** (`asyncio.gather`); results are appended in call order, so a
tool body must be safe to run in parallel. A tool that raises is not caught —
wrap it yourself if you want a tool failure reported back to the model as a
tool-result message instead of aborting the loop.

The loop auto-reports one trace: the gateway records an `llm` span per
round-trip, and the SDK adds a `tool` span per client-side call, threaded into
the same trace via the `x-trace-id` header. Tools that ran on the platform get
their span from the platform, so they land in the same waterfall without being
reported twice. Turn tracing off with `trace=False`, or attach to an existing
trace with `trace={"trace_id": "..."}`.

### Catalog access without the loop

`hub.tools` reaches the catalog directly — useful in a deploy step, or when you
drive the model yourself:

```python
await hub.tools.sync([get_weather], on_conflict="error")   # reconcile at deploy time
resolved = await hub.tools.resolve([{"name": "search_orders"}])
out = await hub.tools.execute(resolved[0].tool_id, {"query": "refunds"})
```

`sync` returns, per tool, the version it landed on and whether this call
committed it. `on_conflict="error"` raises when a commit supersedes a version
someone edited in the dashboard; the default warns instead, so a dashboard
experiment can never block a deploy.

## Bring your own provider (BYO)

`gateway.chat()` and `gateway.run_tool_loop()` can skip our gateway entirely and call your model
provider's OpenAI-compatible endpoint directly — pass a `provider=` argument (or
set one as a client-level default):

```python
result = await hub.gateway.chat(
    "llama-3.1-70b-versatile",
    [{"role": "user", "content": "Hello!"}],
    provider={"base_url": "https://api.groq.com/openai/v1", "api_key": os.environ["GROQ_API_KEY"]},
)
```

This skips the extra network hop through the gateway, and `provider["api_key"]` is sent only
to `provider["base_url"]` — it never reaches acruxcore's servers. Tracing and prompt lineage
still work: a BYO call auto-reports its own `llm` span (tokens, latency, model, payloads —
dollar cost isn't computed for BYO spans yet) plus any `tool` spans, and passing
`prompt_version_id` (from `prompts.render()`'s `version_id`/`version_number`) still links the
trace back to the exact prompt version that produced it. In a BYO `gateway.run_tool_loop()`, each
round's `llm` span is reported as soon as that round returns rather than batched to the end,
so a long loop is observable while it runs — and a platform-executed (`http`) tool's span
nests under the round that called it.

A non-HTTPS `provider["base_url"]` warns once per URL, the same way a non-HTTPS platform
`base_url` already did: the BYO path sends your provider key as a bearer token to that URL,
so plain `http://` to a non-loopback host would send it in cleartext. Loopback URLs
(`http://localhost:11434` and friends) stay quiet.

The gateway path stays untraced by default, because the gateway records its own span there.
You *can* opt in with `trace=True` or `trace={"trace_id": ..., "session_id": ...}` — useful
for threading several manual `gateway.chat()` calls into one trace. Be aware that on the gateway path
this always records a **second** `llm` span for the same completion (under an id of its own,
next to the one the gateway already wrote), so the completion shows up twice: in the
gateway's trace, or in yours plus the gateway's if you pass your own `trace_id`.

## Reporting traces

```python
from datetime import datetime, timezone
now = datetime.now(timezone.utc).isoformat()

res = await hub.traces.ingest({
    "name": "support-agent-run",
    "spans": [
        {"spanId": "s1", "name": "gpt-4o-mini", "kind": "llm", "startTime": now, "endTime": now,
         "model": "gpt-4o-mini", "usage": {"promptTokens": 120, "completionTokens": 40, "totalTokens": 160}},
        {"spanId": "s2", "parentSpanId": "s1", "name": "search_docs", "kind": "tool",
         "startTime": now, "attributes": {"query": "refunds"}},
    ],
})

# Append another span to the same trace later:
await hub.traces.ingest({"traceId": res.trace_id, "spans": [
    {"spanId": "s3", "parentSpanId": "s1", "name": "finalize", "kind": "chain", "startTime": now}]})
```

`kind` is one of `llm | tool | retrieval | embedding | agent | chain | other`;
`status` is `ok | error | unset`. `input`/`output` are stored only when your team
has payload capture on (or you pass `capturePayloads: True`). Up to 200 spans per
call. Span keys are camelCase (`spanId`, `parentSpanId`, `startTime`) because they
are sent to the API verbatim.

### When automatic traces are sent

`traces.ingest()` above is awaited — you get the `trace_id` back. The **automatic** reports
from `gateway.chat()`, streaming `gateway.stream()` and `gateway.run_tool_loop()` are not: they go onto a
background queue so a model call never waits on telemetry. There is no batching
timer, so they aren't delayed either — an idle client sends each span as soon as it
records it, and spans group into one request only while another is already in flight.

One situation needs an extra line:

```python
# Reading the traces API back straight after a call
result = await hub.gateway.chat(model, messages)
await hub.gateway.flush()                      # wait for the spans to be written
detail = await hub.traces.get(result.gateway.trace_id)
```

`gateway.aclose()` flushes before closing the HTTP client, so `async with AcruxCore(...)`
already handles shutdown. A script that finishes and exits needs nothing: an `atexit`
hook drains the queue on a fresh event loop. The SDK installs **no**
`SIGINT`/`SIGTERM` handlers — signal disposition belongs to your application — so a
process killed by a signal drops whatever spans were buffered.

## Feedback

```python
fb = await hub.traces.submit_feedback(
    trace_id,
    rating=-1,                # -1..5
    label="wrong_answer",
    comment="The tool call missed relevant docs.",
    source="end_user",        # 'user' | 'developer' | 'end_user' | 'api'
)

await hub.traces.submit_feedback(trace_id, span_id="s1", rating=5)  # scope to one span

# Edit later (author only). Pass a value to change, None to clear, omit to keep:
await hub.traces.update_feedback(trace_id, fb.id, rating=1)
```

At least one of `rating` / `label` / `comment` is required per call.

## Reading traces back

```python
detail = await hub.traces.get(trace_id)
print(detail.trace.status, detail.trace.total_cost_usd, detail.trace.total_tokens)
print(detail.spans[0].model, detail.spans[0].latency_ms)

page = await hub.traces.list(session_id="tokyo-trip-plan-01", limit=10)
```

## Configuration

| Argument | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `api_key` | `ACRUXCORE_API_KEY` | **required** | Your Acrux Core API key |
| `base_url` | `ACRUXCORE_BASE_URL` | **required** | API base URL (e.g. `https://api.acruxcore.com/api/v1`) |
| `cache_ttl` | — | `60000` (60s) | Milliseconds before a cached render is stale. `0` disables caching |
| `max_cache_size` | — | `500` | Max prompt entries in the in-process LRU cache |
| `max_retries` | — | `1` | Retries on transient failure (2 total attempts) |
| `retry_interval` | — | `500` | Milliseconds between retries |
| `timeout` | — | `30` | Per-request timeout, in seconds |

## Error handling

```python
from acruxcore import AcruxCoreError

try:
    await hub.prompts.render("my-prompt", "production", vars)
except AcruxCoreError as err:
    if err.code == "MISSING_VARIABLES":
        print("Missing template variables:", err.body["error"]["missing"])
    elif err.code == "NETWORK_ERROR":
        print("Acrux Core API unreachable. Check base_url.")
    elif err.code == "API_ERROR":
        print(f"Acrux Core API error {err.status_code}")
    raise
```

Error codes: `MISSING_API_KEY`, `MISSING_BASE_URL`, `NETWORK_ERROR`, `API_ERROR`,
`MISSING_VARIABLES`.

## Caching

- **Cache key:** `{api_key}:{prompt_name}:{alias}:{variables_hash}` — scoped per team,
  prompt, alias, and set of variables, so new variables always re-render. The hash
  ignores key order, so `{"a": 1, "b": 2}` and `{"b": 2, "a": 1}` share one entry.
- **Turning it off:** `cache_ttl=0` disables caching completely — every
  `prompts.render` call hits the API and nothing is stored (so the serve-stale
  behaviour below no longer applies).
- **Stale-while-revalidate:** a stale hit returns the cached value immediately and
  fires a background refresh (`asyncio` task).
- **API unreachable + stale entry:** serves stale and logs a warning.
- **API unreachable + cold cache:** raises `AcruxCoreError(code="NETWORK_ERROR")`.

## Method parity with the TypeScript SDK

| TypeScript | Python |
|------------|--------|
| `renderPrompt(name, alias, vars)` | `prompts.render(name, alias, variables)` |
| `chat({...})` | `gateway.chat(model, messages, *, ...)` |
| `chat({stream: true})` | `gateway.stream(model, messages, *, ...)` → async iterator |
| `runToolLoop({...})` | `gateway.run_tool_loop(model, messages, *, tools=, tool_defs=, tool_refs=, dispatch=None, sync=True, ...)` |
| `chat({provider: {baseUrl, apiKey}})` / `runToolLoop({provider})` — BYO | `gateway.chat(..., provider={"base_url", "api_key"})` / `gateway.run_tool_loop(..., provider=...)` — BYO |
| `acrux.tool({name, parameters}, handler)` | `@acrux.tool` (or `@acrux.tool(parameters={...})`) |
| `hub.tools.sync(tools, {onConflict})` | `hub.tools.sync(tools, on_conflict=...)` |
| `hub.tools.resolve(refs)` | `hub.tools.resolve(refs)` |
| `hub.tools.execute(toolId, args, {...})` | `hub.tools.execute(tool_id, args, ...)` |
| `trace(input)` | `traces.ingest(input)` |
| `submitFeedback({...})` | `traces.submit_feedback(trace_id, *, ...)` |
| `updateFeedback({...})` | `traces.update_feedback(trace_id, feedback_id, *, ...)` |
| `getTrace(id)` | `traces.get(trace_id)` |
| `listTraces({...})` | `traces.list(*, ...)` |
