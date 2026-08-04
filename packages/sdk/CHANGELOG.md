# Changelog — `@acruxcoreai/sdk`

All notable changes to the TypeScript SDK. This package follows
[semver](https://semver.org/spec/v2.0.0.html) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Entries are kept short on purpose: no bullet or migration step runs past three lines.

Platform-wide changes (API, dashboard, docs) are summarised weekly on the public
changelog: <https://docs.acruxcore.com/changelog>
(source: [`apps/docs/src/pages/changelog.md`](../../apps/docs/src/pages/changelog.md)).

## Unreleased

## 0.6.7 — 2026-08-04

### Added

- **`tags` and `metadata` in trace options.** `chat()` and `runToolLoop()` now
  forward `tags` and `metadata` from the trace options as `x-trace-tags` /
  `x-trace-metadata` gateway headers. The `TraceOptions` type is exported for
  typing trace option dicts.

### Changed

- **The npm package page links the source repo again.** `package.json`'s
  `repository` field points at
  [github.com/AcruxCore/AcruxCore](https://github.com/AcruxCore/AcruxCore)
  now that the repo is public — see 0.6.6 below for why it was removed.

## 0.6.6 — 2026-08-01

### Added

- **`responseFormat` on `chat()` and `runToolLoop()`.** A typed passthrough option
  mirroring `tools`/`toolChoice` — sends `response_format` on the gateway request
  body unchanged. Mutually exclusive with `tools`/`toolChoice` on the same request
  (the gateway rejects the combination with 400 `VALIDATION_ERROR`); a loop that
  needs both tool calls and a typed final answer does it in two calls — gather with
  `tools` and no `responseFormat`, then a follow-up call with `responseFormat` set
  and no tools to shape the answer.

### Fixed

- **The npm package page linked the private source repo**, which 404s for anyone
  outside the org. `package.json`'s `repository` field is removed; `homepage` and
  `bugs` still point at public URLs.

## 0.6.5 — 2026-07-31

### Changed

- **Trace reporting no longer blocks a model call.** `chat()`, streaming `chat()` and
  `runToolLoop()` now buffer spans and drain them in the background instead of awaiting
  `POST /traces` — about **570 ms** off every traced BYO call against a hosted API.
- **Traces are not delayed to achieve it.** There is no batching timer: an idle client sends
  each span as soon as it records it, and batching only kicks in while a request is in flight.
- **`runToolLoop` keeps exactly one awaited report** — round 0's `llm` span, and only when the
  loop contains a platform-executed (`http`) tool, which needs the trace to exist before it
  dispatches.
- `trace()` itself is unchanged: still awaited, still returns `{ traceId }`.

### Added

- **`flush()`** waits until every backgrounded trace has been sent. Call it before reading
  the traces API back.
- **`close()`** flushes, stops accepting new spans, and releases the SDK's exit hook. Also
  available as `await using hub = new acruxcore(...)` on Node 20.4 and later.

### Fixed

- **The render cache no longer serves one set of variables' output for another.** The key was
  `apiKeyHash:name:alias`; it is now `apiKeyHash:name:alias:variablesHash`, hashed
  order-independently, so `{ a, b }` and `{ b, a }` stay one entry.
- **`cacheTtl: 0` now disables caching instead of always serving stale.** `age < cacheTtl` is
  never true at `0`, so every hit took the stale path. A non-positive TTL now skips the cache
  on read and write — and gives up the stale fallback when the API is unreachable.

#### Migrating from 0.6

1. If you `chat()` and then **read the traces API back** — in a test, or code polling for the
   span it just produced — insert `await hub.flush()` between the two. **Nothing in the type
   system catches this**: grep for reads of `/traces` following a `chat()` or `runToolLoop()`.
2. If your process is a **long-running server**, call `await hub.close()` in the shutdown path
   you already have. Scripts that finish and exit need no change — a `beforeExit` hook drains them.
3. The SDK installs **no `SIGINT`/`SIGTERM` handlers**, because registering one suppresses
   Node's default terminate behaviour and would break Ctrl-C in your application. A
   signal-killed process drops buffered spans by design.

## 0.6.0

Calls can now go **straight to your own provider**, with the gateway out of the path — and
tracing keeps working anyway, because the SDK reports the spans itself.

### Added

- **BYO (bring-your-own-key) provider support.** `chat()` and `runToolLoop()` accept
  `provider: { baseUrl, apiKey }` (or a client-level default) and call an OpenAI-compatible
  endpoint directly instead of our gateway, streaming or not.
- **The provider key is sent only to `provider.baseUrl`**, never to us — that is the point of
  the option, and the reason a non-HTTPS URL warns (below).
- **A BYO call auto-reports its own trace** — an `llm` span with tokens/latency/model/payloads,
  plus any `tool` spans — so tracing works with no gateway in the path. Dollar cost is not yet
  computed for BYO spans.
- **In a BYO `runToolLoop`, each round's `llm` span is reported as that round returns** rather
  than batched to the end, so a long loop is observable while it runs; a platform-executed
  (`http`) tool's span nests under the round that called it.
- **`chat()` gains `promptVersionId` and a widened `trace` option.** `trace` accepts
  `{ traceId?, sessionId? }` as well as a boolean, so several manual `chat()` calls can be
  threaded into one trace — the mechanism `runToolLoop` already used internally.
- **Careful with `trace` on the gateway path:** opting in there reports an extra client-side
  `llm` span alongside the one the gateway already recorded, so one completion appears twice.
  Leave `trace` unset if you only want the gateway's span.
- **A non-HTTPS `provider.baseUrl` now warns**, once per URL, as a non-HTTPS platform `baseUrl`
  already did — plain `http://` to a non-loopback host would send your key in cleartext.
  Loopback URLs (`http://localhost:11434` and friends) stay quiet.
- **`renderPrompt()` now returns `versionId`/`versionNumber`** — pass either through as
  `promptVersionId` on `chat()`/`runToolLoop()` so a trace can be linked back to the exact
  prompt version that produced it.
- New error code `PROVIDER_ERROR` for a non-2xx response from a BYO provider endpoint.

### Changed

- **HTTP 429 now retries like a 5xx**, on the same `maxRetries`/`retryInterval` budget as every
  other retryable status; previously every 4xx returned immediately. The gateway used to absorb
  rate limits by falling back across providers, which a direct BYO call cannot do.
- **The visible effect:** a rate-limited call takes longer before it surfaces the 429 rather
  than failing fast — set `maxRetries: 0` if you already wrap calls in a retry of your own.

### Fixed

- **A streamed BYO response no longer waits on the connection after it has ended.** `[DONE]`
  only left the frame-parsing loop, so a provider or proxy that holds the connection open
  stalled the call — and its trace report — indefinitely. `[DONE]` now ends the read as well.

## 0.5.0

Tools are now **declared once, in code**. The function is the tool: its name, the
description the model reads, and its argument schema all come from the declaration, and
the loop reconciles that with the Tool Catalog on its first call. Pre-1.0 breaking changes
are intentional — see *Migrating* below.

### Added

- **`acrux.tool`** — declares a tool from a handler plus a `parameters` schema, which accepts a
  **zod** schema or plain **JSON Schema** (zod is converted for you).
- **The declaration is pure**: no network, no import-time side effects, so importing a module
  full of tools cannot make an HTTP call or need an API key
  ([Q30](../../docs/superpowers/specs/phase-4/phase-4-faq.md#q30), [Q31](../../docs/superpowers/specs/phase-4/phase-4-faq.md#q31)).
- **Also exported as `tool`**, with `isAcruxTool`, `resolveParametersSchema` and
  `parseToolArgs` for callers that need the parts.
- **`tools` option on `runToolLoop`** — pass declared tools directly. Their specs sync to the
  catalog once per process (cached on the spec hash and an API-key fingerprint, bounded at 256
  entries), then the loop calls the handlers. An unchanged function commits nothing.
- **`hub.tools` namespace** (`ToolsNamespace`) — `sync`, `resolve` and `execute` against
  the catalog, for callers that want the pieces rather than the loop. Types:
  `ToolSyncOptions`, `ToolExecuteOptions`.
- **`_resetSyncCacheForTesting`** — clears the per-process sync cache. Test-only.

### Changed

- **BREAKING — `runToolLoop`'s `tools` option changed meaning.** It now takes tools declared
  with `acrux.tool`; raw OpenAI-shaped definitions moved to **`toolDefs`**, which behaves
  exactly as `tools` did. A raw definition is the escape hatch now, not the default.
- **`dispatch` is now optional** (it was required). It is needed only for `toolDefs` and
  for a `client` ref with no matching declared tool.
- **`runToolLoop` routes by executor type.** An `http` ref is executed server-side, a `client`
  ref locally. Previously `toolRefs` implied server-side, which made a client-run tool awkward
  ([Q33](../../docs/superpowers/specs/phase-4/phase-4-faq.md#q33)).
- **`MISSING_DISPATCH` is raised before the first model call**, not partway through the loop,
  so a tool with nothing to run costs zero tokens instead of failing after you have paid for
  a completion.

### Migrating from 0.4.x

1. **If you passed `tools: [{ type: 'function', function: {...} }]`, rename the option to
   `toolDefs`.** This is the only required edit, and TypeScript points at it — leaving it
   unrenamed is a type error, not a silent behaviour change.
2. `dispatch` may stay exactly where it is; it is optional now, not gone.
3. `toolRefs` is unchanged, with one caveat: routing follows the version's declared
   `executorType`, and the catalog answers `422 NOT_EXECUTABLE` to anyone asking it to run a
   `client` version. Check each version declares the executor matching who really runs the tool.
4. Optional, and the point of the release: drop the create → commit → promote calls you
   make before the loop, declare the tool with `acrux.tool(...)`, and pass it via `tools`.

## 0.4.x and earlier

Not tracked here — this file starts at 0.5.0.
