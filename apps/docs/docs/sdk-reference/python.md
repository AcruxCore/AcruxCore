---
title: Python SDK reference
description: Every method and parameter in acruxcore, the Python SDK for AcruxCore — render, chat, tool loops, tracing, feedback, and the tool catalog.
keywords: [python sdk, AcruxCore sdk, llm sdk python, async llm sdk]
---

# Python SDK reference

`acruxcore` is the async Python SDK for AcruxCore. It renders stored prompts,
calls the gateway (with streaming, tools, and structured output), runs the
tool-calling loop, reports and reads traces, and manages the tool catalog. Every
method below has a 1:1 Node counterpart in [`@acruxcoreai/sdk`](./node) — only
the casing and a few option shapes differ.

```bash
pip install acruxcore
```

The SDK is async throughout, so `AcruxCore` is an async context manager. Create
one instance at startup and reuse it.

## Construct the client

```python
import asyncio
from acruxcore import AcruxCore

async def main():
    # Reads ACRUXCORE_API_KEY and ACRUXCORE_BASE_URL from the environment.
    async with AcruxCore() as hub:
        ...

asyncio.run(main())
```

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `api_key` | `str` | `ACRUXCORE_API_KEY` | Raises `MISSING_API_KEY` if neither is set. |
| `base_url` | `str` | `ACRUXCORE_BASE_URL` | Raises `MISSING_BASE_URL` if neither is set. |
| `cache_ttl` | `int` (ms) | `60000` | Render cache window. `0` disables caching (and serve-stale). |
| `max_cache_size` | `int` | `500` | Max LRU entries. Set by the first instance. |
| `max_retries` | `int` | `1` | Retries on transient failure (2 total attempts). |
| `retry_interval` | `int` (ms) | `500` | Delay between retries. |
| `timeout` | `float` (s) | `30.0` | Per-request timeout. |
| `transport` | `httpx.AsyncBaseTransport` | — | For testing/injection. |
| `provider` | [`ProviderConfig`](#byo-provider) | — | Client-level BYO default; overridden by a per-call `provider`. |

Errors raise `AcruxCoreError` with a machine-readable `code` — see
[Error codes](#error-codes).

## `prompts.render(name, alias, variables=None)`

Render a stored prompt by name + alias into templated messages, plus the tools
attached to that version. Cached per `(api_key, name, alias, variables)` with
stale-while-revalidate: a fresh hit returns immediately, a stale hit returns
immediately and refreshes in the background, a cold miss fetches.

```python
rendered = await hub.prompts.render(
    "support-reply", "production",
    {"company": "Acme", "customer_message": "Order #123 is late"},
)
print(rendered.messages, rendered.model)
```

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `name` | `str` | yes | Prompt slug (not id). |
| `alias` | `str` | yes | e.g. `"production"`, `"staging"`. |
| `variables` | `dict` | no | Template variables. Defaults to `{}`. |

**Returns** `RenderResult(messages, tools, model, version_id, version_number)`.
`model` is the version's bound default (or `None`); pass `version_id` to
`gateway.chat()`/`gateway.run_tool_loop()` as `prompt_version_id` for prompt lineage on a trace.
Raises `MISSING_VARIABLES` if the template needs a variable you did not supply.

## Prompt lifecycle (`hub.prompts`)

### `prompts.list(*, search=None, page=None, limit=None)`

List prompts for the team, newest first.

```python
page = await hub.prompts.list(search="support", limit=10)
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `search` | `str` | Free-text search on name. |
| `page` | `int` | 1-based page. |
| `limit` | `int` | Page size. |

**Returns** `PromptListResult(data, total, page, limit)`.

### `prompts.get(prompt_id)`

Fetch one prompt by id.

```python
prompt = await hub.prompts.get(prompt_id)
```

**Returns** `PromptDetail` (`id`, `name`, `description`, `version_count`, `created_at`, `updated_at`).

### `prompts.create(name, *, description=None)`

Create a new prompt shell. Commit a version with `commit_version` to give it content.

```python
prompt = await hub.prompts.create("support-bot", description="Customer support")
```

**Returns** `PromptDetail`.

### `prompts.update(prompt_id, **kwargs)`

Update a prompt's name and/or description. Does not touch versions.

```python
updated = await hub.prompts.update(prompt_id, description="v2 description")
```

**Returns** `PromptDetail`.

### `prompts.delete(prompt_id)`

Delete a prompt and every version/alias under it. Returns `None`.

```python
await hub.prompts.delete(prompt_id)
```

### `prompts.commit_version(prompt_id, messages, *, model=None, tools=None)`

Commit a new immutable version for a prompt. The first commit auto-creates `production` and `staging` aliases.

```python
version = await hub.prompts.commit_version(
    prompt_id,
    messages=[
        {"role": "system", "content": "You are a support agent."},
        {"role": "user", "content": "{{question}}"},
    ],
    model="gpt-4o-mini",
)
```

**Returns** `VersionDetail` (`id`, `version_number`, `messages`, `model`, `tools`, `aliases`).
`aliases` is present only on the first version.

### `prompts.list_versions(prompt_id, *, page=None, limit=None)`

List a prompt's versions, newest first. Items omit `messages` — use `get_version` for full content.

```python
versions = await hub.prompts.list_versions(prompt_id)
```

**Returns** `VersionListResult(data, total, page, limit)`.

### `prompts.get_version(prompt_id, version_number)`

Fetch one version with its full messages.

```python
v = await hub.prompts.get_version(prompt_id, 1)
```

**Returns** `VersionDetail`.

### `prompts.diff(prompt_id, from_version, to_version)`

Diff two versions.

```python
diff = await hub.prompts.diff(prompt_id, 1, 2)
```

**Returns** `DiffResult` (`changes`).

### `prompts.promote_alias(prompt_id, alias, version_number)`

Point an alias (e.g. `"production"`) at a specific version. Creates the alias if it doesn't exist.

```python
alias = await hub.prompts.promote_alias(prompt_id, "production", 3)
```

**Returns** `AliasDetail` (`alias`, `version_number`, `prompt_id`).

### `prompts.export_version(prompt_id, version_number)`

Export a version for portability (JSON blob).

```python
exported = await hub.prompts.export_version(prompt_id, 1)
```

**Returns** `ExportedPromptVersion`.

### `prompts.import_prompt(export_data)`

Import an exported prompt as a new prompt with one version.

```python
imported = await hub.prompts.import_prompt(exported)
```

**Returns** `ImportPromptResult` (`prompt_id`, `prompt_name`, `version_number`).

### `prompts.traces_for_version(prompt_id, version_number, *, limit=None, page=None)`

List traces that used a specific prompt version.

```python
traces = await hub.prompts.traces_for_version(prompt_id, 1, limit=10)
```

**Returns** `TraceListResult(data, total, page, limit)`.

## `gateway.chat(...)`

One gateway completion at `POST /gateway/chat/completions` — no tool-dispatch
loop. If the model returns `tool_calls`, they are handed back raw on
`result.message["tool_calls"]`; use [`gateway.run_tool_loop`](#gatewayrun_tool_loop) to
dispatch them.

```python
reply = await hub.gateway.chat("support-model", rendered.messages, temperature=0.2)
print(reply.content, reply.usage)
```

For streaming, use `gateway.stream()` which returns an async iterator of chunks:

```python
stream = await hub.gateway.stream("support-model", rendered.messages)
async for chunk in stream:
    print(chunk.delta.get("content", ""), end="", flush=True)
```

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `model` | `str` | yes | Model public name. |
| `messages` | `list[dict]` | yes | Chat messages. |
| `tools` | `list[ToolDefinition]` | no | Inline OpenAI-shaped tool definitions. |
| `tool_refs` | `list[{name, alias?}]` | no | Catalog tool references (resolved server-side). |
| `tool_choice` | `ToolChoice` | no | How the model uses tools. |
| `response_format` | [`ResponseFormat`](#structured-output) | no | Structured output. Mutually exclusive with `tools`/`tool_choice`. |
| `temperature` | `float` | no | Sampling temperature. |
| `max_tokens` | `int` | no | Max completion tokens. |
| `stream` | `bool` | no | Return an async iterator of `ChatChunk` instead of `ChatResult`. |
| `provider` | [`ProviderConfig`](#byo-provider) | no | Per-call BYO override. |
| `prompt_version_id` | `str` | no | From `prompts.render().version_id`; stamped on the trace span. |
| `trace` | `bool \| {trace_id?, session_id?}` | no | Default `True` on the BYO path, `False` on the gateway path. |

**Returns** `ChatResult` (`id`, `model`, `content`, `message`, `finish_reason`,
`usage`, `gateway`) or, when streaming via `gateway.stream()`, an async iterator of `ChatChunk`.
`gateway` carries `request_id`, `provider`, `model`, `cost_usd`, `cache`,
`trace_id`, and `span_ref` read from the gateway's `x-gateway-*` headers.

:::note
`response_format` and `tools`/`tool_choice`/`tool_refs` cannot ride the same
gateway request — the gateway returns a 400. To get a typed answer that also
calls tools, pass both to [`gateway.run_tool_loop`](#gatewayrun_tool_loop); the SDK gathers with
tools, then makes one shaping call with the format.
:::

## `gateway.run_tool_loop(...)`

The full agent loop: calls the model, runs the tools it asks for, appends the
results, and repeats until the model stops calling tools or `max_iterations` is
hit. Tools requested in one turn run concurrently.

```python
from acruxcore import acrux

@acrux.tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. 'Lahore'.
    """
    return {"tempC": 21}

result = await hub.gateway.run_tool_loop(
    "agent-model",
    [{"role": "user", "content": "Weather in Lahore?"}],
    tools=[get_weather],
)
print(result.content, result.trace_id)
```

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `model` | `str` | yes | Model public name. |
| `messages` | `list[dict]` | yes | Seed messages. |
| `tools` | `list[Callable]` | no | Functions decorated with [`@acrux.tool`](#acruxtool). Run locally; reconciled with the catalog. |
| `tool_defs` | `list[ToolDefinition]` | no | Raw OpenAI definitions, sent inline; route to `dispatch`. |
| `tool_refs` | `list[{name, alias?}]` | no | Catalog refs. `http` executor runs on the platform. |
| `dispatch` | `Callable[[str, dict], Any]` | no | `(name, args) -> result` (sync or async). Required for `tool_defs` and for `client` refs with no matching decorated tool. |
| `sync` | `bool` | no | Reconcile `tools` with the catalog first. Default `True`. |
| `max_iterations` | `int` | no | Max round-trips. Default `10`. |
| `temperature` | `float` | no | Sampling temperature. |
| `max_tokens` | `int` | no | Max completion tokens. |
| `response_format` | [`ResponseFormat`](#structured-output) | no | Shapes the final answer; may be combined with tools (gather + shape). |
| `trace` | `bool \| {trace_id?, name?, session_id?}` | no | Default `True`. |
| `provider` | [`ProviderConfig`](#byo-provider) | no | Per-call BYO override. |
| `prompt_version_id` | `str` | no | Stamped on every `llm` span this loop records. |

**Returns** `RunToolLoopResult(content, messages, iterations, stopped_at_limit, trace_id)`.
Raises `MISSING_DISPATCH` before the first model call if a tool has no runner.

## `traces.ingest(input)`

Report a trace (a group of spans) to AcruxCore. A single-trace convenience over
the batch endpoint — omit `traceId` to mint a new trace, pass one to append.

```python
result = await hub.traces.ingest({
    "name": "rag-pipeline",
    "spans": [
        {"spanId": "retrieval-1", "name": "vector-search", "kind": "retrieval",
         "status": "ok", "startTime": "2026-01-01T00:00:00Z",
         "endTime": "2026-01-01T00:00:01Z",
         "input": {"query": "shipping policy"}, "output": {"hits": 4}},
    ],
})
print(result.trace_id)
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `traceId` | `str` | no | Omit to mint a new trace; pass one to append. |
| `sessionId` | `str` | no | Groups traces into a session. |
| `name` | `str` | no | Trace name. |
| `capturePayloads` | `bool` | no | Force payload capture on for this trace. |
| `tags` | `list[str]` | no | Set on creation; merged (union) on append. |
| `metadata` | `dict` | no | Set on creation; shallow-merged on append. |
| `spans` | `list[IngestSpan]` | yes | The spans to report — see [Span shapes](#span-shapes). |

**Returns** `TraceResult(trace_id)`.

## `traces.submit_feedback(...)` / `traces.update_feedback(...)`

Attach feedback to a trace (or one span), then edit it in place. Only the
original author may edit.

```python
fb = await hub.traces.submit_feedback(trace_id, rating=5, label="helpful", comment="Resolved my issue.")
await hub.traces.update_feedback(trace_id, fb.id, rating=1, label="unhelpful")
```

`submit_feedback(trace_id, *, ...)` — at least one of `rating`/`label`/`comment`:

| Field | Type | Notes |
|-------|------|-------|
| `trace_id` | `str` | Required (positional). |
| `span_id` | `str` | Scope to one span. |
| `rating` | `int` | `-1..5`. |
| `label` | `str` | Short label. |
| `comment` | `str` | Free text. |
| `source` | `str` | `"user" \| "developer" \| "end_user" \| "api"`. |

`update_feedback(trace_id, feedback_id, *, rating=..., label=..., comment=...)` —
pass a value to change it, `None` to clear it, or omit the argument to keep the
existing value (uses an `Ellipsis` sentinel internally).

**Returns** `FeedbackResult` (`id`, `trace_id`, `span_id`, `rating`, `label`,
`comment`, `source`, `created_by`, `created_at`, `updated_at`).

## `traces.get(trace_id)` / `traces.list(...)`

Read traces back. `traces.get` returns the header plus the full span tree;
`traces.list` returns one page of summaries, newest first.

```python
full = await hub.traces.get(trace_id)
print(full.trace, full.spans)

page = await hub.traces.list(status="error", min_latency_ms=2000, limit=20)
print(page.data, page.total)
```

`traces.list(*, ...)` filters — all keyword-only and optional:

| Field | Type | Notes |
|-------|------|-------|
| `from_` / `to` | `str` | ISO date range (`from_` maps to `from`). |
| `status` | `str` | `'ok' \| 'error' \| 'unset'`. |
| `model` | `str` | Filter by model. |
| `session_id` | `str` | Filter by session. |
| `prompt_version_id` | `str` | Filter by prompt version. |
| `min_latency_ms` | `int` | Minimum latency. |
| `min_cost_usd` | `float` | Minimum cost. |
| `min_tokens` | `int` | Minimum total tokens. |
| `q` | `str` | Free-text search. |
| `page` / `limit` | `int` | Pagination (1-based page). |

`traces.get` returns `GetTraceResult(trace, spans)`; `traces.list` returns
`ListTracesResult(data, total, page, limit)`.

## Trace analytics (`hub.traces`)

### `traces.analytics(*, group_by=None, since=None, until=None)`

Aggregated trace metrics (latency, cost, tokens) grouped by a facet.

```python
analytics = await hub.traces.analytics(group_by="model")
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `group_by` | `str` | Facet key to group by (e.g. `"model"`, `"status"`). |
| `since` / `until` | `str` | ISO-8601 time bounds. |

**Returns** `AnalyticsResult` (`data`).

### `traces.list_facets()`

Discover available facet keys for grouping.

```python
facets = await hub.traces.list_facets()
```

**Returns** `TraceFacets` — object whose keys are facet names.

### `traces.get_facet_values(key)`

Get distinct values for a facet key.

```python
values = await hub.traces.get_facet_values("model")
```

**Returns** `FacetValuesResult` (`values`).

### `traces.get_settings()` / `traces.update_settings(capture_payloads)`

Read or update the team's trace capture settings.

```python
settings = await hub.traces.get_settings()
await hub.traces.update_settings(True)  # enable payload capture
```

**Returns** `TraceSettings` (`capture_payloads`).

### `traces.get_feedback_summary(*, since=None, until=None)`

Aggregated feedback buckets (rating distribution).

```python
summary = await hub.traces.get_feedback_summary()
```

**Returns** `FeedbackSummaryResult` (`data`).

### `traces.list_feedback(*, limit=None, page=None)`

Paginated feedback list across all traces.

```python
feedback = await hub.traces.list_feedback(limit=10)
```

**Returns** `FeedbackListResult` (`data`, `total`, `page`, `limit`).

### `traces.get_trace_feedback(trace_id)`

All feedback for a specific trace.

```python
fb = await hub.traces.get_trace_feedback(trace_id)
```

**Returns** `TraceFeedbackResult` (`data`).

## `gateway.flush()` / `gateway.aclose()`

```python
await hub.gateway.flush()    # wait for background trace writes to finish
await hub.gateway.aclose()   # flush, then close the HTTP client
```

`gateway.chat()`, streaming, and `gateway.run_tool_loop()` hand back their result without waiting
for the trace write — call `gateway.flush()` before reading the traces API back. A script
that returns from `main()` does not need either: the SDK drains at interpreter
exit. `gateway.aclose()` is also called by the `async with AcruxCore()` context manager.

## Tool catalog (`hub.tools`)

Catalog operations live on `hub.tools`.

### `tools.sync(...)` / `tools.sync_one(...)`

Reconcile tools from [`@acrux.tool`](#acruxtool) against the catalog. Idempotent
and cached per process on the spec hash — a second call with an unchanged tool
makes no request.

```python
await hub.tools.sync([get_weather])
one = await hub.tools.sync_one(get_weather.__acrux_tool__, on_conflict="error")
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `tools` / `spec` | `list[Callable]` / `ToolSpec` | Decorated functions (for `sync`) or a `ToolSpec` (for `sync_one`). |
| `on_conflict` | `str` | Default `"warn"`. `"error"` raises when a commit supersedes a dashboard-authored version. |

**Returns** a list of `ToolSyncResult` (`tool_id`, `version_number`, `committed`,
`alias`, `superseded_source`) from `sync`, or a single one from `sync_one`.
`committed` is `False` on a cache hit.

### `tools.resolve(refs)`

Resolve catalog refs to schemas plus executor types in one request.

```python
[resolved] = await hub.tools.resolve([{"name": "get_weather", "alias": "production"}])
# resolved.tool_id, resolved.executor_type ('client' | 'http'), resolved.function
```

**Returns** `list[ResolvedTool]` (`tool_id`, `version_number`, `executor_type`,
`function`). Raises `API_ERROR` (`404`) when any ref does not resolve.

### `tools.execute(tool_id, args, *, ...)`

Run a tool's server-side `http` executor on the platform. The platform writes
the `tool` span itself — do not report one for the same call.

```python
out = await hub.tools.execute(
    tool_id, {"city": "Lahore"},
    alias="production", trace_id=trace_id, parent_span_id=llm_span_ref,
)
print(out.result, out.latency_ms, out.tool_version_id)
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `tool_id` | `str` | From `resolve()`. Required (positional). |
| `args` | `dict` | The model's parsed arguments. Required (positional). |
| `alias` | `str` | Which alias to run. |
| `version_number` | `int` | Pin an exact version. |
| `trace_id` | `str` | Attach the span to this trace. |
| `parent_span_id` | `str` | Nest under this span (normally the `llm` span). |

**Returns** `ToolExecuteResult(result, status, latency_ms, tool_version_id)`.

### `tools.list(*, search=None, page=None, limit=None)`

List tools for the team, newest first.

```python
page = await hub.tools.list(search="weather", limit=10)
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `search` | `str` | Free-text search on name. |
| `page` | `int` | 1-based page. |
| `limit` | `int` | Page size. |

**Returns** `ToolListResult(data, total, page, limit)`.

### `tools.get(tool_id)`

Fetch one tool's shell by id.

```python
tool = await hub.tools.get(tool_id)
```

**Returns** `ToolDetail` (`id`, `name`, `description`, `latest_version`, `created_at`, `updated_at`).

### `tools.create(name, *, description=None)`

Create a new tool shell. Commit a version with `commit_version` to give it a schema/executor.

```python
tool = await hub.tools.create("get_weather", description="Weather lookup")
```

**Returns** `ToolDetail`.

### `tools.update(tool_id, **kwargs)`

Update a tool's name and/or description. Does not touch versions.

```python
updated = await hub.tools.update(tool_id, description="Updated description")
```

**Returns** `ToolDetail`.

### `tools.delete(tool_id)`

Soft-delete a tool. Versions and aliases are preserved but unreachable. Returns `None`.

```python
await hub.tools.delete(tool_id)
```

### `tools.commit_version(tool_id, *, description=None, parameters_schema, executor, changelog=None)`

Commit a new immutable version for a tool. The first commit auto-creates `production` and `staging` aliases.

```python
version = await hub.tools.commit_version(
    tool_id,
    description="Get weather for a city",
    parameters_schema={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    executor={"type": "client"},
)
```

**Returns** `ToolVersionDetail`.

### `tools.list_versions(tool_id, *, page=None, limit=None)`

List a tool's versions, newest first. Items omit `parameters_schema`/`executor`.

```python
versions = await hub.tools.list_versions(tool_id)
```

**Returns** `ToolVersionListResult(data, total, page, limit)`.

### `tools.get_version(tool_id, version_number)`

Fetch one version with its full `parameters_schema`/`executor`.

```python
v = await hub.tools.get_version(tool_id, 1)
```

**Returns** `ToolVersionDetail`.

### `tools.promote_alias(tool_id, alias, version_number)`

Promote an alias to point at a specific version. Creates the alias if it doesn't exist.

```python
alias = await hub.tools.promote_alias(tool_id, "production", 2)
```

**Returns** `ToolAliasDetail` (`alias`, `version_number`, `tool_id`).

### `tools.analytics(*, since=None, until=None)`

Read aggregated call analytics (count, error rate, p50/p95 latency) per tool.

```python
analytics = await hub.tools.analytics(since="2026-01-01T00:00:00Z")
```

**Returns** `ToolAnalyticsResult` (`data`).

## `@acrux.tool`

Mark a function as a tool, deriving its name, description, and parameter schema
from the function itself. Works bare (`@acrux.tool`) and called
(`@acrux.tool(alias="staging")`). The function stays directly callable.

```python
from acruxcore import acrux

@acrux.tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. 'Lahore'.
    """
    return {"tempC": 21}
```

The decorator is **pure** — it performs no network calls and has no import-time
side effects. The schema is derived from the signature; supported hints are
`str`, `int`, `float`, `bool`, `list[T]`, `dict`, `Optional[T]`, `Literal[...]`,
and `Enum` subclasses. A parameter without a default is `required`, and each
parameter's `description` comes from the docstring's Google-style `Args:` block.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `fn` | `Callable` | (bare use) | The function, when used bare. Never pass explicitly. |
| `name` | `str` | no | Defaults to the function's name. |
| `description` | `str` | no | Defaults to the docstring's first paragraph. |
| `parameters` | `dict` | no | Hand-written JSON Schema; skips derivation. The escape hatch for a type this converter cannot model. |
| `alias` | `str` | no | Catalog alias a sync moves. Default `"production"`. |
| `changelog` | `str` | no | Release note for humans; never shown to the model. |

A function with **no docstring** sends no description, which hands ownership of
the model-facing text to the dashboard. Raises `ToolSchemaError` at decoration
time when the schema cannot be derived (a missing hint, an unsupported type, or
`*args`/`**kwargs`).

## Structured output

`response_format` asks the model for a typed answer. Pass an OpenAI-shaped dict,
or build one from a [pydantic](https://docs.pydantic.dev) v2 model with
`pydantic_response_format` — field-level `Field(description=...)` guidance
reaches the model without hand-writing JSON Schema.

```python
from pydantic import BaseModel, Field
from acruxcore import pydantic_response_format

class Sentiment(BaseModel):
    """Classify the message."""
    sentiment: str = Field(description="'pos', 'neg', or 'neutral'")

await hub.gateway.chat(
    "agent-model", messages,
    response_format=pydantic_response_format(Sentiment, name="sentiment"),
)
```

Pydantic is an *optional* dependency — `pydantic_response_format()` does not
import it; the SDK resolves the schema at send time. The available shapes:

| Variant | Shape |
|---------|-------|
| text | `{"type": "text"}` |
| json_object | `{"type": "json_object"}` |
| json_schema | `{"type": "json_schema", "json_schema": {"name": ..., "schema": ..., "strict": ...}}` |
| pydantic | `pydantic_response_format(Model, *, name, strict=True)` |

The gateway forwards the format to each provider's native structured-output mode
and relies on the provider to honour it — it does not validate the returned
content against the schema, so parse and validate on your side when conformance
matters. Raises `PYDANTIC_NOT_AVAILABLE` if a pydantic-built format is sent but
pydantic is not installed.

## BYO provider

Route a call directly to your own OpenAI-compatible endpoint instead of the
gateway — the hop and its latency are skipped, and `api_key` is sent only to
`base_url`, never to AcruxCore.

```python
hub = AcruxCore(
    provider={"base_url": "https://api.groq.com/openai/v1", "api_key": os.environ["GROQ_API_KEY"]},
)
```

Pass `provider` to the constructor (a default for every call) or per-call to
`gateway.chat()`/`gateway.run_tool_loop()`. There is no server-side catalog on this path, so
every tool is sent inline as a full schema, and the SDK reports one `llm` span
per round-trip. `gateway.cost_usd` and `gateway.cache` are always `None` (the
gateway never saw the call). Raises `PROVIDER_ERROR` for a non-2xx provider
response.

## Span shapes

`IngestSpan` (the dict shape passed in `spans` to [`traces.ingest()`](#tracesingestinput)):

| Field | Type | Notes |
|-------|------|-------|
| `spanId` | `str` | Required; opaque, unique within the trace. |
| `parentSpanId` | `str` | Links to another span's `spanId`. |
| `name` | `str` | Required. |
| `kind` | `str` | `'llm' \| 'tool' \| 'retrieval' \| 'embedding' \| 'agent' \| 'chain' \| 'other'`. |
| `status` | `str` | `'ok' \| 'error' \| 'unset'`. |
| `startTime` | `str` | Required; ISO-8601 with offset. |
| `endTime` | `str` | ISO-8601. |
| `model`, `provider` | `str` | Model/provider metadata. |
| `usage` | `dict` | `{promptTokens?, completionTokens?, totalTokens?}`. |
| `costUsd` | `float` | Cost in USD. |
| `promptVersionId` | `str` | Prompt lineage. |
| `input` / `output` | `any` | Stored only with payload capture on. |
| `attributes` | `dict` | Free-form. |
| `error` | `str` | Error message for failed spans. |

## Error codes

All failures raise `AcruxCoreError` with a `code` attribute — use it for
programmatic handling rather than matching on the message.

| Code | When it is raised |
|------|-------------------|
| `MISSING_API_KEY` | No `api_key` in args or env; or a BYO `provider["api_key"]` is empty. |
| `MISSING_BASE_URL` | No `base_url` in args or env; or a BYO `provider["base_url"]` is empty. |
| `NETWORK_ERROR` | All retries exhausted at the network level. |
| `API_ERROR` | Non-retryable HTTP error from the gateway (4xx, or 5xx after retries). Inspect `status_code`/`body`. |
| `MISSING_VARIABLES` | Template requires variables you did not supply. |
| `TOOL_SCHEMA_ERROR` | `@acrux.tool`: a missing hint, an unsupported type, or `*args`/`**kwargs`. |
| `MISSING_DISPATCH` | `run_tool_loop`: a tool has no implementation (raised before the first model call). |
| `PYDANTIC_NOT_AVAILABLE` | A pydantic-built `response_format` was sent but pydantic is not installed. |
| `PROVIDER_ERROR` | BYO: non-2xx response from your provider endpoint. |

## Sessions (`hub.sessions`)

### `sessions.list(*, page=None, limit=None)`

List sessions with pagination.

```python
page = await hub.sessions.list(limit=10)
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `page` | `int` | 1-based page. |
| `limit` | `int` | Page size. |

**Returns** `SessionListResult(data, total, page, limit)`.

### `sessions.get(session_id)`

Get session detail with all traces.

```python
session = await hub.sessions.get(session_id)
```

**Returns** `SessionDetailResult` (`session`, `traces`).

## Evaluations

### Datasets (`hub.datasets`)

| Method | Description |
|--------|-------------|
| `datasets.create(name, *, overall_feedback=None)` | Create a dataset. Returns `DatasetDto`. |
| `datasets.build_from_feedback(name, feedback_ids, *, overall_feedback=None)` | Build a dataset from trace feedback. Returns `BuildFromFeedbackResult`. |
| `datasets.list()` | List all datasets. Returns `list[DatasetDto]`. |
| `datasets.get(dataset_id)` | Get dataset with examples. Returns `DatasetWithExamples`. |
| `datasets.update(dataset_id, **kwargs)` | Update dataset metadata (`name`, `overall_feedback`). Returns `DatasetDto`. |
| `datasets.delete(dataset_id)` | Delete a dataset. Returns `None`. |
| `datasets.add_example(dataset_id, input, *, criteria=None, history=None)` | Add an example. Returns `DatasetExampleDto`. |
| `datasets.remove_example(dataset_id, example_id)` | Remove an example. Returns `None`. |

### Experiments (`hub.experiments`)

| Method | Description |
|--------|-------------|
| `experiments.create(dataset_id, version_ids, models, *, prompt_id=None, name=None, alias=None)` | Create an experiment. Returns `ExperimentDto`. |
| `experiments.list()` | List all experiments. Returns `list[ExperimentDto]`. |
| `experiments.get(experiment_id)` | Get an experiment. Returns `ExperimentDto`. |
| `experiments.start_run(experiment_id)` | Start a run. Returns `StartRunResult` (`run_id`, `status`). |

### Runs (`hub.runs`)

| Method | Description |
|--------|-------------|
| `runs.list(*, status=None, dataset_id=None, prompt_id=None, page=None, limit=None)` | List runs. Returns `RunListResponse`. |
| `runs.get(run_id)` | Get run detail. Returns `RunDetailDto`. |
| `runs.get_report(run_id)` | Get run report. Returns `RunReport`. |
| `runs.get_cell(run_id, cell_key)` | Get a specific cell. Returns `RunCellDetailDto`. |
| `runs.get_candidate(run_id, candidate_id)` | Get a candidate. Returns `CandidateDetail`. |
| `runs.promote_candidate(run_id, prompt_candidate_id, *, alias=None)` | Promote a candidate. Returns `PromoteResult`. |

### Optimize (`hub.optimize`)

| Method | Description |
|--------|-------------|
| `optimize.start(prompt_id, dataset_id, models, *, draft_count=None, alias=None)` | Start prompt optimization. Returns `StartOptimizeResult` (`run_id`, `status`, `prompt_mismatch_warning`). |

## Where to next

- [Quickstart](../getting-started/quickstart) — make your first call in ten minutes.
- [Build and attach a tool](../guides/build-and-attach-a-tool) — the tool loop, end to end.
- [Chat, stream, and collect feedback with the SDK](../guides/use-the-sdk-for-chat-and-feedback).
- [Node SDK reference](./node) — same methods, TypeScript style.
