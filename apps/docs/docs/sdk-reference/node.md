---
title: Node SDK reference
description: Every method and parameter in @acruxcoreai/sdk, the Node/TypeScript SDK for Acrux Core — render, chat, tool loops, tracing, feedback, and the tool catalog.
keywords: [node sdk, typescript sdk, acrux core sdk, llm sdk typescript]
---

# Node SDK reference

`@acruxcoreai/sdk` is the Node/TypeScript SDK for Acrux Core. It renders stored
prompts, calls the gateway (with streaming, tools, and structured output), runs
the tool-calling loop, reports and reads traces, and manages the tool catalog.
Every method below has a 1:1 Python counterpart in
[`acruxcore`](./python) — only the casing and a few option-object shapes differ.

```bash
npm install @acruxcoreai/sdk
```

## Construct the client

```typescript
import AcruxCore from '@acruxcoreai/sdk';

// Reads ACRUXCORE_API_KEY and ACRUXCORE_BASE_URL from the environment.
const hub = new AcruxCore();
```

Create one instance at process startup and reuse it. The render cache is a
module-level singleton sized by the first constructor.

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `apiKey` | `string` | `process.env.ACRUXCORE_API_KEY` | Throws `MISSING_API_KEY` if neither is set. |
| `baseUrl` | `string` | `process.env.ACRUXCORE_BASE_URL` | Throws `MISSING_BASE_URL` if neither is set. |
| `cacheTtl` | `number` (ms) | `60000` | Render cache freshness window. `0` disables caching (and serve-stale). |
| `maxCacheSize` | `number` | `500` | Max LRU entries. Set by the first constructor. |
| `maxRetries` | `number` | `1` | Retries on transient failure (2 total attempts). |
| `retryInterval` | `number` (ms) | `500` | Delay between retries. |
| `provider` | [`ProviderConfig`](#byo-provider) | — | Client-level BYO default; overridden by a per-call `provider`. |

Errors throw an `acruxcoreError` with a machine-readable `code` — see
[Error codes](#error-codes).

## `renderPrompt(name, alias, variables?)`

Render a stored prompt by name + alias into templated messages, plus the tools
attached to that version. Cached per `(apiKey, name, alias, variables)` with
stale-while-revalidate: a fresh hit returns immediately, a stale hit returns
immediately and refreshes in the background, a cold miss fetches.

```typescript
const { messages, tools, model, versionId } = await hub.renderPrompt(
  'support-reply',
  'production',
  { company: 'Acme', customer_message: 'Order #123 is late' },
);
```

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `name` | `string` | yes | Prompt slug (not id). |
| `alias` | `string` | yes | e.g. `'production'`, `'staging'`. |
| `variables` | `Record<string, unknown>` | no | Template variables. Defaults to `{}`. |

**Returns** `{ messages, tools, model, versionId, versionNumber }`. `model` is the
version's bound default (or `null`); pass `versionId` to `chat()`/`runToolLoop()`
as `promptVersionId` for prompt lineage on a trace. Throws `MISSING_VARIABLES`
if the template needs a variable you did not supply.

## `chat(options)`

One gateway completion at `POST /gateway/chat/completions` — no tool-dispatch
loop. If the model returns `tool_calls`, they are handed back raw on
`result.message.tool_calls`; use [`runToolLoop`](#runtoolloopoptions) to dispatch
them.

```typescript
const { content, usage, gateway } = await hub.chat({
  model: 'support-model',
  messages,
  temperature: 0.2,
});
```

With `stream: true`, `chat()` returns an async iterable of chunks:

```typescript
const stream = await hub.chat({ model: 'support-model', messages, stream: true });
for await (const chunk of stream) process.stdout.write(chunk.delta.content ?? '');
```

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `model` | `string` | yes | Model public name. |
| `messages` | `Message[]` | yes | Chat messages. |
| `tools` | `ToolDefinition[]` | no | Inline OpenAI-shaped tool definitions. |
| `toolRefs` | `{ name; alias? }[]` | no | Catalog tool references (resolved server-side). |
| `toolChoice` | `'auto' \| 'none' \| 'required' \| { type:'function'; function:{name} }` | no | How the model uses tools. |
| `responseFormat` | [`ResponseFormat`](#structured-output) | no | Structured output. Mutually exclusive with `tools`/`toolChoice`. |
| `temperature` | `number` | no | Sampling temperature. |
| `maxTokens` | `number` | no | Max completion tokens. |
| `stream` | `boolean` | no | Return an async iterable of `ChatChunk` instead of `ChatResult`. |
| `provider` | [`ProviderConfig`](#byo-provider) | no | Per-call BYO override. |
| `promptVersionId` | `string` | no | From `renderPrompt().versionId`; stamped on the trace span. |
| `trace` | `boolean \| { traceId?; sessionId? }` | no | Default `true` on the BYO path, `false` on the gateway path. |

**Returns** `ChatResult` (`{ id, model, content, message, finishReason, usage?, gateway }`)
or, when streaming, an `AsyncGenerator<ChatChunk>`. `gateway` carries
`requestId`, `provider`, `model`, `costUsd`, `cache`, `traceId`, and `spanRef`
read from the gateway's `x-gateway-*` headers.

:::note
`responseFormat` and `tools`/`toolChoice`/`toolRefs` cannot ride the same gateway
request — the gateway returns a 400. To get a typed answer that also calls tools,
pass both to [`runToolLoop`](#runtoolloopoptions); the SDK gathers with tools,
then makes one shaping call with the format.
:::

## `runToolLoop(options)`

The full agent loop: calls the model, runs the tools it asks for, appends the
results, and repeats until the model stops calling tools or `maxIterations` is
hit. Tools requested in one turn run concurrently.

```typescript
import { acrux } from '@acruxcoreai/sdk';

const getWeather = acrux.tool(
  { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  async ({ city }) => ({ tempC: 21 }),
);

const { content, traceId } = await hub.runToolLoop({
  model: 'agent-model',
  messages: [{ role: 'user', content: 'Weather in Lahore?' }],
  tools: [getWeather],
});
```

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `model` | `string` | yes | Model public name. |
| `messages` | `Message[]` | yes | Seed messages. |
| `tools` | `AcruxTool[]` | no | Tools from [`acrux.tool`](#acruxtool). Run locally; reconciled with the catalog. |
| `toolDefs` | `ToolDefinition[]` | no | Raw OpenAI definitions, sent inline; route to `dispatch`. |
| `toolRefs` | `{ name; alias? }[]` | no | Catalog refs. `http` executor runs on the platform. |
| `dispatch` | `(name, args) => unknown \| Promise<unknown>` | no | Fallback runner. Required for `toolDefs` and for `client` refs with no matching `tools` entry. |
| `sync` | `boolean` | no | Reconcile `tools` with the catalog first. Default `true`. |
| `maxIterations` | `number` | no | Max round-trips. Default `10`. |
| `temperature` | `number` | no | Sampling temperature. |
| `maxTokens` | `number` | no | Max completion tokens. |
| `responseFormat` | [`ResponseFormat`](#structured-output) | no | Shapes the final answer; may be combined with tools (gather + shape). |
| `trace` | `boolean \| { traceId?; name?; sessionId? }` | no | Default `true`. |
| `provider` | [`ProviderConfig`](#byo-provider) | no | Per-call BYO override. |
| `promptVersionId` | `string` | no | Stamped on every `llm` span this loop records. |

**Returns** `RunToolLoopResult` (`{ content, messages, iterations, stoppedAtLimit, traceId? }`).
Throws `MISSING_DISPATCH` before the first model call if a tool has no runner.

## `trace(input)`

Report a trace (a group of spans) to Acrux Core. A single-trace convenience over
the batch endpoint — omit `traceId` to mint a new trace, pass one to append.

```typescript
const { traceId } = await hub.trace({
  name: 'rag-pipeline',
  spans: [
    { spanId: 'retrieval-1', name: 'vector-search', kind: 'retrieval', status: 'ok',
      startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:01Z',
      input: { query: 'shipping policy' }, output: { hits: 4 } },
  ],
});
```

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `traceId` | `string` | no | Omit to mint a new trace; pass one to append. |
| `sessionId` | `string` | no | Groups traces into a session. |
| `name` | `string` | no | Trace name. |
| `capturePayloads` | `boolean` | no | Force payload capture on for this trace. |
| `tags` | `string[]` | no | Set on creation; merged (union) on append. |
| `metadata` | `Record<string, unknown>` | no | Set on creation; shallow-merged on append. |
| `spans` | [`IngestSpan[]`](#span-shapes) | yes | The spans to report. |

**Returns** `{ traceId }`.

## `submitFeedback(input)` / `updateFeedback(input)`

Attach feedback to a trace (or one span), then edit it in place. Only the
original author may edit.

```typescript
const fb = await hub.submitFeedback({
  traceId,
  rating: 5,
  label: 'helpful',
  comment: 'Resolved my issue.',
});
await hub.updateFeedback({ traceId, feedbackId: fb.id, rating: 1, label: 'unhelpful' });
```

`submitFeedback` input — at least one of `rating`/`label`/`comment`:

| Field | Type | Notes |
|-------|------|-------|
| `traceId` | `string` | Required. |
| `spanId` | `string` | Scope to one span. |
| `rating` | `number` | `-1..5`. |
| `label` | `string` | Short label. |
| `comment` | `string` | Free text. |
| `source` | `'user' \| 'developer' \| 'end_user' \| 'api'` | Origin. |

`updateFeedback` input — `{ traceId, feedbackId, rating?, label?, comment? }`. Pass
`null` to clear a field; omit it to keep the existing value.

**Returns** `FeedbackResult` (`{ id, traceId, spanId, rating, label, comment, source, createdBy, createdAt, updatedAt }`).

## `getTrace(traceId)` / `listTraces(options?)`

Read traces back. `getTrace` returns the header plus the full span tree;
`listTraces` returns one page of summaries, newest first.

```typescript
const { trace, spans } = await hub.getTrace(traceId);
const page = await hub.listTraces({ status: 'error', minLatencyMs: 2000, limit: 20 });
```

`listTraces` filters — all optional:

| Field | Type | Notes |
|-------|------|-------|
| `from` / `to` | `string` | ISO date range. |
| `status` | `SpanStatus` | `'ok' \| 'error' \| 'unset'`. |
| `model` | `string` | Filter by model. |
| `sessionId` | `string` | Filter by session. |
| `promptVersionId` | `string` | Filter by prompt version. |
| `minLatencyMs` | `number` | Minimum latency. |
| `minCostUsd` | `number` | Minimum cost. |
| `minTokens` | `number` | Minimum total tokens. |
| `q` | `string` | Free-text search. |
| `page` / `limit` | `number` | Pagination (1-based page). |

`getTrace` returns `{ trace: TraceSummary, spans: TraceSpan[] }`; `listTraces`
returns `{ data: TraceSummary[], total, page, limit }`.

## `flush()` / `close()`

```typescript
await hub.flush();   // wait for background trace writes to finish
await hub.close();   // flush, then release the exit hook
```

`chat()`, streaming, and `runToolLoop()` hand back their result without waiting
for the trace write — call `flush()` before reading the traces API back. A script
that returns from `main()` does not need either: the SDK flushes at process exit.
`close()` is idempotent and also supports `await using hub = new AcruxCore(...)`.

## Tool catalog (`hub.tools`)

Catalog operations live on `hub.tools`.

### `tools.sync(tools, options?)` / `tools.syncOne(tool, options?)`

Reconcile tools from [`acrux.tool`](#acruxtool) against the catalog. Idempotent
and cached per process on the spec hash — a second call with an unchanged tool
makes no request.

```typescript
await hub.tools.sync([getWeather]);
const one = await hub.tools.syncOne(getWeather, { onConflict: 'error' });
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `tools` / `tool` | `AcruxTool` | From `acrux.tool`. |
| `options.onConflict` | `'warn' \| 'error'` | Default `'warn'`. `'error'` throws when a commit supersedes a dashboard-authored version. |

**Returns** `ToolSyncResult` (`{ toolId, versionNumber, committed, alias, supersededSource? }`).
`committed` is `false` on a cache hit.

### `tools.resolve(refs)`

Resolve catalog refs to schemas plus executor types in one request.

```typescript
const [resolved] = await hub.tools.resolve([{ name: 'get_weather', alias: 'production' }]);
// resolved.toolId, resolved.executorType ('client' | 'http'), resolved.function
```

**Returns** `ResolvedTool[]` (`{ toolId, versionNumber, executorType, function }`).
Throws `API_ERROR` (`404`) when any ref does not resolve.

### `tools.execute(toolId, args, options?)`

Run a tool's server-side `http` executor on the platform. The platform writes
the `tool` span itself — do not report one for the same call.

```typescript
const { result, latencyMs, toolVersionId } = await hub.tools.execute(toolId, { city: 'Lahore' }, {
  alias: 'production',
  traceId,
  parentSpanId: llmSpanRef,
});
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `toolId` | `string` | From `resolve()`. Required. |
| `args` | `Record<string, unknown>` | The model's parsed arguments. Required. |
| `options.alias` | `string` | Which alias to run. |
| `options.versionNumber` | `number` | Pin an exact version. |
| `options.traceId` | `string` | Attach the span to this trace. |
| `options.parentSpanId` | `string` | Nest under this span (normally the `llm` span). |

**Returns** `ToolExecuteResult` (`{ result, status, latencyMs, toolVersionId }`).

## `acrux.tool`

Declare a tool whose interface and implementation live in one value. The model
sees the `name` and `parameters` schema; your `handler` runs when it calls the
tool. Works with a [zod](https://zod.dev) schema (typed args) or a plain JSON
Schema object (untyped args).

```typescript
import { acrux } from '@acruxcoreai/sdk';
import { z } from 'zod/v4';

const getWeather = acrux.tool(
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: z.object({ city: z.string() }),
    alias: 'production',
  },
  async ({ city }) => ({ tempC: 21 }),
);
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | yes | Must match `^[a-zA-Z0-9_-]{1,64}$`. |
| `description` | `string` | no | **What the model reads.** Omit to let the dashboard own it. |
| `parameters` | `z.ZodSchema \| Record<string, unknown>` | yes | zod v4 schema or a JSON Schema object. |
| `alias` | `string` | no | Catalog alias a sync moves. Default `'production'`. |
| `changelog` | `string` | no | Release note for humans; never shown to the model. |

The second argument is `handler: (args) => unknown | Promise<unknown>`.
`acrux.tool()` itself throws `TOOL_SCHEMA_ERROR` for an invalid name. The zod
schema is converted to JSON Schema lazily at sync time, so `ZOD_NOT_AVAILABLE`
(zod given but not installed) and the `TOOL_SCHEMA_ERROR` for a classic zod v3
schema surface from `tools.sync()` / the first loop call — not from `acrux.tool()`.

## Structured output

`responseFormat` asks the model for a typed answer. Pass an OpenAI-shaped dict,
or build one from a zod schema with the `{ zod, name, strict? }` variant — the
SDK converts it to JSON Schema at send time.

```typescript
await hub.chat({
  model: 'agent-model',
  messages,
  responseFormat: { zod: z.object({ sentiment: z.enum(['pos', 'neg', 'neutral']) }), name: 'sentiment' },
});
```

| Variant | Shape |
|---------|-------|
| text | `{ type: 'text' }` |
| json_object | `{ type: 'json_object' }` |
| json_schema | `{ type: 'json_schema', json_schema: { name, schema?, strict? } }` |
| zod | `{ zod: ZodSchema, name, strict? }` |

The gateway forwards the format to each provider's native structured-output mode
and relies on the provider to honour it — it does not validate the returned
content against the schema, so parse and validate on your side when conformance
matters.

## BYO provider

Route a call directly to your own OpenAI-compatible endpoint instead of the
gateway — the hop and its latency are skipped, and `apiKey` is sent only to
`baseUrl`, never to Acrux Core.

```typescript
const hub = new AcruxCore({
  apiKey: process.env.ACRUXCORE_API_KEY,
  baseUrl: process.env.ACRUXCORE_BASE_URL,
  provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY },
});
```

Pass `provider` on the constructor (a default for every call) or per-call on
`chat()`/`runToolLoop()`. There is no server-side catalog on this path, so every
tool is sent inline as a full schema, and the SDK reports one `llm` span per
round-trip. `gateway.costUsd` and `gateway.cache` are always `null` (the gateway
never saw the call). Throws `PROVIDER_ERROR` for a non-2xx provider response.

## Span shapes

`IngestSpan` (passed to [`trace()`](#traceinput)):

| Field | Type | Notes |
|-------|------|-------|
| `spanId` | `string` | Required; opaque, unique within the trace. |
| `parentSpanId` | `string` | Links to another span's `spanId`. |
| `name` | `string` | Required. |
| `kind` | `SpanKind` | `'llm' \| 'tool' \| 'retrieval' \| 'embedding' \| 'agent' \| 'chain' \| 'other'`. |
| `status` | `SpanStatus` | `'ok' \| 'error' \| 'unset'`. |
| `startTime` | `string` | Required; ISO-8601 with offset. |
| `endTime` | `string` | ISO-8601. |
| `model`, `provider` | `string` | Model/provider metadata. |
| `usage` | `{ promptTokens?; completionTokens?; totalTokens? }` | Token usage. |
| `costUsd` | `number` | Cost in USD. |
| `promptVersionId` | `string` | Prompt lineage. |
| `input` / `output` | `unknown` | Stored only with payload capture on. |
| `attributes` | `Record<string, unknown>` | Free-form. |
| `error` | `string` | Error message for failed spans. |

## Error codes

All failures throw an `acruxcoreError` with a `code` field — use it for
programmatic handling rather than matching on the message.

| Code | When it is thrown |
|------|-------------------|
| `MISSING_API_KEY` | No `apiKey` in args or env; or a BYO `provider.apiKey` is empty. |
| `MISSING_BASE_URL` | No `baseUrl` in args or env; or a BYO `provider.baseUrl` is empty. |
| `NETWORK_ERROR` | All retries exhausted at the network level. |
| `API_ERROR` | Non-retryable HTTP error from the gateway (4xx, or 5xx after retries). Inspect `statusCode`/`body`. |
| `MISSING_VARIABLES` | Template requires variables you did not supply. |
| `TOOL_SCHEMA_ERROR` | `acrux.tool`: invalid name, an unsupported parameters shape, or a classic zod v3 schema. |
| `MISSING_DISPATCH` | `runToolLoop`: a tool has no implementation (thrown before the first model call). |
| `ZOD_NOT_AVAILABLE` | A zod schema was given but zod could not be imported. |
| `PROVIDER_ERROR` | BYO: non-2xx response from your provider endpoint. |

## Where to next

- [Quickstart](../getting-started/quickstart) — make your first call in ten minutes.
- [Build and attach a tool](../guides/build-and-attach-a-tool) — the tool loop, end to end.
- [Chat, stream, and collect feedback with the SDK](../guides/use-the-sdk-for-chat-and-feedback).
- [Python SDK reference](./python) — same methods, Python style.
