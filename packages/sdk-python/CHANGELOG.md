# Changelog — `acruxcore`

All notable changes to the Python SDK. This package follows
[semver](https://semver.org/spec/v2.0.0.html) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Entries are kept short on purpose: no bullet or migration step runs past three lines.

Platform-wide changes (API, dashboard, docs) are summarised weekly on the public
changelog: <https://docs.acruxcore.com/changelog>
(source: [`apps/docs/src/pages/changelog.md`](../../apps/docs/src/pages/changelog.md)).

## Unreleased

## 0.7.1 — 2026-08-07

### Changed

- The product name is now written as one word, "AcruxCore", in the package
  description and in every docstring.
- No API, behaviour, or type changes. Upgrading from 0.7.0 needs no code edits.

## 0.7.0 — 2026-08-05

### BREAKING

- **Resource-based namespace pattern.** All flat client methods removed — use `hub.gateway.*`, `hub.prompts.render()`, `hub.traces.*` instead.
  - `hub.chat(...)` → `hub.gateway.chat(...)`
  - `hub.chat(stream=True, ...)` → `hub.gateway.stream(...)`
  - `hub.run_tool_loop(...)` → `hub.gateway.run_tool_loop(...)`
  - `hub.flush()` / `hub.aclose()` → `hub.gateway.flush()` / `hub.gateway.aclose()`
  - `hub.render_prompt(...)` → `hub.prompts.render(...)`
  - `hub.trace(...)` → `hub.traces.ingest(...)`
  - `hub.get_trace(...)` → `hub.traces.get(...)`
  - `hub.list_traces(...)` → `hub.traces.list(...)`
  - `hub.submit_feedback(...)` → `hub.traces.submit_feedback(...)`
  - `hub.update_feedback(...)` → `hub.traces.update_feedback(...)`

### Added

- **`GatewayNamespace`** — new class at `gateway_api.py` consolidating all gateway operations (chat, stream, run_tool_loop, flush, aclose).
- **`hub.prompts.render()`** — replaces `render_prompt()` with built-in SWR cache.
- **Trace CRUD on `hub.traces`** — `ingest`, `get`, `list`, `submit_feedback`, `update_feedback`.
- **`NamespaceHost` / `GatewayNamespaceHost` protocols** — shared host contract (`host.py`), all existing namespace host interfaces now extend it.
- **`tools.sync_one`** — renamed from `sync_spec` for TS parity.
- **`hub.traces` and `hub.sessions` namespaces.** Trace analytics, facet
  discovery, payload-capture settings, feedback summary/list, and session
  listing — ten endpoints that previously had no SDK binding.

  ```python
  stats = await hub.traces.analytics(group_by="model")
  facets = await hub.traces.list_facets()
  sessions = await hub.sessions.list(limit=20)
  ```
- **`client.prompts` — prompt version lifecycle.** New namespace: create/read/update/delete
  prompts, commit immutable versions, list/get them, diff two versions, promote
  aliases, export/import versions, and look up a version's traces.

  ```python
  prompt = await client.prompts.create(name="support-agent")
  version = await client.prompts.commit_version(
      prompt.id,
      messages=[{"role": "system", "content": "You are a helpful support agent."}],
  )
  await client.prompts.promote_alias(prompt.id, "production", version.version_number)
  traces = await client.prompts.traces_for_version(prompt.id, version.version_number)
  ```
- **Tool catalog lifecycle via SDK.** `client.tools` gained management for tool
  shells (`create`, `list`, `get`, `update`, `delete`), versions (`commit_version`,
  `list_versions`, `get_version`), alias promotion (`promote_alias`), and analytics.
- Evaluations domain: `hub.datasets`, `hub.experiments`, `hub.runs`, `hub.optimize` — 19 methods covering the full evaluations API (datasets, experiments, runs, prompt optimization).

## 0.6.7 — 2026-08-04

### Added

- **`tags` and `metadata` in trace options.** `chat()` and `run_tool_loop()` now
  forward `tags` and `metadata` from the trace options as `x-trace-tags` /
  `x-trace-metadata` gateway headers.

### Changed

- **The PyPI project page links the source repo again.** `pyproject.toml`'s
  `[project.urls]` gains `Repository`, pointing at
  [github.com/AcruxCore/AcruxCore](https://github.com/AcruxCore/AcruxCore) now
  that the repo is public.

## 0.6.6 — 2026-08-01

### Added

- **`response_format` on `chat()` and `run_tool_loop()`.** A typed passthrough option
  mirroring `tools`/`tool_choice` — sends `response_format` on the gateway request
  body unchanged. Mutually exclusive with `tools`/`tool_choice` on the same request
  (the gateway rejects the combination with 400 `VALIDATION_ERROR`); a loop that
  needs both tool calls and a typed final answer does it in two calls — gather with
  `tools` and no `response_format`, then a follow-up call with `response_format` set
  and no tools to shape the answer.

### Fixed

- **`acruxcore.__version__` reported a stale `0.6.0`** after the 0.6.5 release —
  the release step bumps `pyproject.toml`/PyPI but this constant is
  hand-maintained, and it was missed. Anyone introspecting `__version__` at
  runtime got the wrong answer; it now matches the installed package version.

## 0.6.5 — 2026-07-31

### Changed

- **Trace reporting no longer blocks a model call.** `chat()`, streaming `chat()` and
  `run_tool_loop()` now buffer spans and drain them in a background task instead of awaiting
  `POST /traces` — about **570 ms** off every traced BYO call against a hosted API.
- **Traces are not delayed to achieve it.** There is no batching timer: an idle client sends
  each span as soon as it records it, and batching only kicks in while a request is in flight.
- **`run_tool_loop` keeps exactly one awaited report** — round 0's `llm` span, and only when the
  loop contains a platform-executed (`http`) tool, which needs the trace to exist before it
  dispatches.
- **`aclose()` now flushes pending traces** before closing the HTTP client, so
  `async with AcruxCore(...)` needs no change.
- `trace()` itself is unchanged: still awaited, still returns `TraceResult(trace_id=...)`.

### Added

- **`flush()`** waits until every backgrounded trace has been sent. Call it before reading
  the traces API back.

### Fixed

- **The render cache no longer serves one set of variables' output for another.** The key was
  `api_key_hash:name:alias`; it is now `api_key_hash:name:alias:variables_hash`, hashed with
  sorted keys so the order you pass variables in does not split the entry.
- **`cache_ttl=0` now disables caching instead of always serving stale.** `age < cache_ttl` is
  never true at `0`, so every hit took the stale path. A non-positive TTL now skips the cache
  on read and write — and gives up the stale fallback when the API is unreachable.

#### Migrating from 0.6

1. If you `gateway.chat()` and then **read the traces API back** — in a test, or code polling for the
   span it just produced — insert `await hub.gateway.flush()` between the two. **Nothing catches this
   for you**: grep for reads of `/traces` following a `gateway.chat()` or `gateway.run_tool_loop()` call.
2. Code that only uses `async with` is already fine. A **long-running server** that builds the
   client by hand should call `await hub.gateway.aclose()` in its shutdown path; scripts that finish and
   exit need no change — an `atexit` hook drains them on a fresh event loop.
3. The SDK installs **no `SIGINT`/`SIGTERM` handlers** — signal disposition belongs to your
   application, not to a library. If you kill a process with a signal, buffered spans are
   dropped by design.

## 0.6.0

Calls can now go **straight to your own provider**, with the gateway out of the path — and
tracing keeps working anyway, because the SDK reports the spans itself.

### Added

- **BYO (bring-your-own-key) provider support.** `chat()` and `run_tool_loop()` accept
  `provider={"base_url": ..., "api_key": ...}` (or a client-level default) and call an
  OpenAI-compatible endpoint directly instead of our gateway, streaming or not.
- **The provider key is sent only to `provider["base_url"]`**, never to us — that is the point
  of the argument, and the reason a non-HTTPS URL warns (below).
- **A BYO call auto-reports its own trace** — an `llm` span with tokens/latency/model/payloads,
  plus any `tool` spans — so tracing works with no gateway in the path. Dollar cost is not yet
  computed for BYO spans.
- **In a BYO `run_tool_loop()`, each round's `llm` span is reported as that round returns**
  rather than batched to the end, so a long loop is observable while it runs; a
  platform-executed (`http`) tool's span nests under the round that called it.
- **`chat()` gains `prompt_version_id` and a widened `trace` argument.** `trace` accepts
  `{"trace_id": ..., "session_id": ...}` as well as a bool, so several manual `chat()` calls can
  be threaded into one trace — the mechanism `run_tool_loop` already used internally.
- **Careful with `trace` on the gateway path:** opting in there reports an extra client-side
  `llm` span alongside the one the gateway already recorded, so one completion appears twice.
  Leave `trace` unset if you only want the gateway's span.
- **A non-HTTPS `provider["base_url"]` now warns**, once per URL, as a non-HTTPS platform
  `base_url` already did — plain `http://` to a non-loopback host would send your key in
  cleartext. Loopback URLs (`http://localhost:11434` and friends) stay quiet.
- **`render_prompt()` now returns `version_id`/`version_number`** — pass either through as
  `prompt_version_id` on `chat()`/`run_tool_loop()` so a trace can be linked back to the exact
  prompt version that produced it.
- New error code `PROVIDER_ERROR` for a non-2xx response from a BYO provider endpoint.

### Changed

- **HTTP 429 now retries like a 5xx**, on the same `max_retries`/`retry_interval` budget as every
  other retryable status; previously every 4xx returned immediately. The gateway used to absorb
  rate limits by falling back across providers, which a direct BYO call cannot do.
- **The visible effect:** a rate-limited call takes longer before it surfaces the 429 rather
  than failing fast — set `max_retries=0` if you already wrap calls in a retry of your own.

### Fixed

- **A dropped connection part-way through a BYO stream no longer replays the whole completion.**
  The retry loop wrapped the streaming read, so a network error after chunks had been yielded
  restarted the request: the caller saw a truncated response followed by a complete one.
- **Retries now stop once the first chunk has been delivered** (matching the TypeScript SDK,
  which only ever retried connection setup), and an interrupted stream raises `NETWORK_ERROR`
  instead of silently duplicating output.
- **A streamed BYO response no longer waits on the connection after it has ended.** `[DONE]`
  only left the frame-parsing loop, so a provider or proxy that holds the connection open
  stalled the call — and its trace report — indefinitely. `[DONE]` now ends the read as well.

## 0.5.0

Tools are now **declared once, in code**. `@acrux.tool` reads the function itself — its
name, its docstring, its type hints — and `run_tool_loop` reconciles that with the Tool
Catalog on its first call. Pre-1.0 breaking changes are intentional; see *Migrating* below.

### Added

- **`@acrux.tool`** (also exported as `tool`) — the tool's name comes from the function name,
  its model-facing description from the **first paragraph** of the docstring, and its argument
  schema from the parameter **type hints**. Both are overridable via decorator arguments.
- **Everything after the docstring's first blank line stays in the source**, so implementation
  notes for your team never reach the model.
- **The decorator is pure**: no network, no import-time side effects, so importing a module
  full of tools cannot make an HTTP call or need an API key
  ([Q30](../../docs/superpowers/specs/phase-4/phase-4-faq.md#q30), [Q31](../../docs/superpowers/specs/phase-4/phase-4-faq.md#q31)).
- **`ToolSpec`** and **`spec_of(obj)`** — the derived spec, and a way to read it off a
  decorated function without calling it.
- **`ToolSchemaError`** (code `TOOL_SCHEMA_ERROR`) — raised at decoration time when a
  parameter's type cannot be modelled, naming the parameter, the cause, and both escape
  hatches. Without it the error named nothing useful.
- **It fires on the PEP 563 footgun in particular**: a class defined **inside a function** is
  unresolvable from module globals, so `get_type_hints` fails before the converter is reached
  ([design spec](../../docs/superpowers/specs/phase-4/2026-07-27-tool-path-simplification-design.md)).
- **`tools=` on `run_tool_loop`** — pass decorated functions directly. Their specs sync to the
  catalog once per process, then the loop calls them; an unchanged function commits nothing.
  Pass `sync=False` when a deploy step already synced them.
- **`client.tools` namespace** (`ToolsNamespace`) — `sync`, `sync_spec`, `resolve` and
  `execute` against the catalog, for callers who want the pieces rather than the loop.
- **`MISSING_DISPATCH`** error code, raised **before the first model call** so a tool with
  nothing to run costs zero tokens instead of failing after you have paid for a completion.

### Changed

- **BREAKING — `run_tool_loop`'s `tools=` argument changed meaning.** It now takes decorated
  functions. Raw OpenAI-shaped definitions moved to the new **`tool_defs=`** argument, which
  behaves exactly as `tools=` did.
- **BREAKING — `dispatch` is now keyword-only and optional.** It was the third positional
  parameter and required. It is needed only for `tool_defs=` and for a `client` ref with no
  matching decorated function.
- **`run_tool_loop` routes by executor type.** An `http` ref is executed server-side, a `client`
  ref locally. Previously `tool_refs` implied server-side, which made a client-run tool awkward
  ([Q33](../../docs/superpowers/specs/phase-4/phase-4-faq.md#q33)).

### Migrating from 0.4.x

1. **Move `dispatch` to a keyword argument.** `run_tool_loop(model, messages, dispatch)`
   becomes `run_tool_loop(model, messages, dispatch=dispatch)`. Python raises a
   `TypeError` if you miss one, so this cannot fail silently.
2. **If you passed `tools=[{"type": "function", ...}]`, rename it to `tool_defs=`.** This is the
   edit to be careful about: nothing catches it at runtime, so grep your calls.
3. `tool_refs=` is unchanged, with one caveat: routing follows the version's declared
   `executorType`, and the catalog answers `422 NOT_EXECUTABLE` to anyone asking it to run a
   `client` version. Check each version declares the executor matching who really runs the tool.
4. Optional, and the point of the release: drop the create → commit → promote calls you make
   before the loop, decorate the function with `@acrux.tool`, and pass it via `tools=`.

## 0.4.1 — first published release

Initial PyPI release (`pip install acruxcore`). Async, full parity with the TypeScript SDK
at that point: prompt render, gateway chat and streaming, tool loops, traces, feedback.
