# @acruxcoreai/sdk

TypeScript SDK for acruxcore. Fetch rendered prompts at runtime without touching your database or managing version numbers.

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Installation

```bash
npm install @acruxcoreai/sdk
```

## Quickstart

```typescript
import acruxcore from '@acruxcoreai/sdk';
import OpenAI from 'openai';

const hub = new acruxcore({
  apiKey: process.env.ACRUXCORE_API_KEY,
  baseUrl: process.env.ACRUXCORE_BASE_URL,
});

const openai = new OpenAI();

async function runAgent(userMessage: string) {
  // Fetch the latest production prompt — no deploy needed to update it
  const { messages } = await hub.prompts.render('summarise-article', 'production', {
    article: userMessage,
  });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
  });

  return response.choices[0].message.content;
}
```

## Chat

A single-request wrapper over acruxcore's gateway (`POST /gateway/chat/completions`)
— the OpenAI-compatible endpoint that routes to the right provider, prices the
call, and traces it server-side. Use it for one completion, not a tool loop:

```typescript
const result = await hub.gateway.chat({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in one word.' }],
});

console.log(result.content);        // 'Hello!'
console.log(result.finishReason);   // 'stop'
console.log(result.usage);          // { promptTokens, completionTokens, totalTokens }
console.log(result.gateway);        // { requestId, provider, model, costUsd, cache }
```

Pass `tools`/`toolRefs`/`toolChoice` the same way you would to the raw gateway
endpoint. If the model calls a tool, `chat()` hands `tool_calls` back raw —
it never auto-dispatches; use `runToolLoop` below for that.

`chat()` isn't auto-traced: the gateway already records a trace for every
completion it serves, and `result.gateway.requestId` correlates the call with
it. Opt in anyway with `trace: true` or `trace: { traceId, sessionId }` to
thread several manual `chat()` calls into one trace — this always adds a
**second** `llm` span for the same completion, so it shows up twice: once in
the gateway's trace, once in yours.

## Streaming

Use `hub.gateway.stream()` to get an async iterable of chunks instead of a single
result:

```typescript
for await (const chunk of await hub.gateway.stream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count to three.' }],
})) {
  process.stdout.write(chunk.delta.content ?? '');
  if (chunk.finishReason) console.log('\n(done:', chunk.finishReason, ')');
}
```

Each `chunk` mirrors one `chat.completion.chunk` SSE frame from the gateway
(`id`, `model`, `delta.content`, `finishReason`); the generator ends when the
gateway sends `data: [DONE]`.

## Tools

Declare a tool once with `acrux.tool` — name, description, parameter schema,
and handler together, nothing to keep in sync by hand — and hand it to the loop:

```typescript
import AcruxCore, { acrux } from '@acruxcoreai/sdk';
import { z } from 'zod/v4';

const getWeather = acrux.tool(
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: z.object({ city: z.string().describe("City name, e.g. 'London'") }),
  },
  async ({ city }) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    const data = (await res.json()) as { current_condition: { temp_C: string }[] };
    return { city, tempC: Number(data.current_condition[0].temp_C) };
  },
);

const hub = new AcruxCore();
const result = await hub.gateway.runToolLoop({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'What is the weather in London?' }],
  tools: [getWeather],
});

console.log(result.content);     // final assistant text
console.log(result.messages);    // full transcript, including tool calls/results
console.log(result.iterations);  // number of model round-trips taken
console.log(result.traceId);     // trace covering every round-trip + tool call
```

The handler's argument is typed from the schema — `{ city }` is a `string`,
not `unknown` — so renaming a field in the zod object breaks the build instead
of the model and your code silently drifting apart.

On first call, `runToolLoop` **syncs** each declared tool into the Tool
Catalog and passes it to the model as a `toolRefs` entry instead of an inline
definition — so the dashboard shows a version history, and every `tool` span
records the exact version that ran. The sync is idempotent and cached per
process (one request per unchanged tool; a changed one commits a new version
and moves its alias). Pass `sync: false` when a deploy step already synced them.

`parameters` also accepts a plain JSON Schema object, so zod is an **optional**
peer dependency — install it only if you want to use it:

```typescript
const countRows = acrux.tool(
  {
    name: 'count_rows',
    parameters: {
      type: 'object',
      properties: { table: { type: 'string' } },
      required: ['table'],
      additionalProperties: false,
    },
  },
  async (args) => ({ rows: await countIn(String(args.table)) }),
);
```

Omitting `description` leaves whatever your team wrote in the dashboard in
place; supplying one makes code own it — every sync overwrites the dashboard's
text. Pick per tool which side owns the wording.

### Catalog tools you didn't declare

A tool whose catalog version has an **`http` executor** needs no local code at
all. Name it in `toolRefs` and the platform calls the endpoint, writes the
`tool` span with the real payloads, and hands the result back to the loop:

```typescript
const result = await hub.gateway.runToolLoop({
  model: 'gpt-4o-mini',
  messages,
  toolRefs: [{ name: 'search_orders', alias: 'production' }],
});
```

`dispatch` still exists for two cases: raw OpenAI-shaped definitions passed as
`toolDefs`, and a `toolRefs` entry with a `client` executor you haven't
declared. If neither a declared tool nor `dispatch` can run it, the loop throws
`MISSING_DISPATCH` **before** the first model call — no tokens spent.

```typescript
const result = await hub.gateway.runToolLoop({
  model: 'gpt-4o-mini',
  messages,
  toolDefs: rawOpenAiToolDefinitions,
  dispatch: async (name, args) => runMyTool(name, args),
});
```

Prompt-attached tools arrive this way too: `prompts.render` returns
`{ messages, tools }` where `tools` are the version's attached catalog tools in
OpenAI shape — those go in `toolDefs`.

### The loop's behaviour

The loop stops when the model responds without calling a tool, or after
`maxIterations` round-trips (default 10, `result.stoppedAtLimit` is `true`
then). Several tools requested in one turn run **concurrently**, appended in
call order regardless of which finishes first — so a handler must be safe to
run in parallel. A handler that throws propagates out of `runToolLoop`
uncaught; wrap it yourself to report a tool failure back to the model instead.

The loop auto-reports one trace: an `llm` span per round-trip (with the
gateway's usage/cost metadata) plus a `tool` span per client-side call.
Platform-run tools get their span from the platform, so nothing is reported
twice. Turn tracing off with `trace: false`, or attach to a trace you already
have with `trace: { traceId }`:

```typescript
const result = await hub.gateway.runToolLoop({ model: 'gpt-4o-mini', messages, tools: [getWeather], trace: false });
```

### Catalog access without the loop

`hub.tools` reaches the catalog directly — useful in a deploy step, or when you
drive the model yourself:

```typescript
await hub.tools.sync([getWeather], { onConflict: 'error' });  // reconcile at deploy time
const resolved = await hub.tools.resolve([{ name: 'search_orders' }]);
const out = await hub.tools.execute(resolved[0].toolId, { query: 'refunds' });
```

`sync` returns, per tool, the version it landed on and whether this call
committed it. `onConflict: 'error'` throws when a commit would supersede a
dashboard-edited version; the default just warns, so a dashboard experiment
never blocks a deploy.

## Bring your own provider (BYO)

Skip our gateway and call your model provider's OpenAI-compatible endpoint
directly — pass a `provider` option (or set one as a client-level default):

```typescript
const result = await hub.gateway.chat({
  model: 'llama-3.1-70b-versatile',
  messages: [{ role: 'user', content: 'Hello!' }],
  provider: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY! },
});
```

`provider.apiKey` goes only to `provider.baseUrl` — never to acruxcore's servers.
Tracing and prompt lineage still work: a BYO call auto-reports its own `llm`
span (tokens, latency, model, payloads — no dollar cost yet) plus any `tool`
spans, and `promptVersionId` (from `prompts.render()`) still links the trace to
the prompt version that produced it.

## Reporting traces

Report your own traces — LLM calls, tool calls, retrieval, custom steps — so a
whole agent run shows up as one trace. Omit `traceId` to start a new trace; pass
one you already have (from a previous `traces.ingest()` call, or minted by the gateway)
to add more spans to it.

```typescript
const { traceId } = await hub.traces.ingest({
  name: 'support-agent-run',
  spans: [
    {
      spanId: 's1',
      name: 'gpt-4o-mini',
      kind: 'llm',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      model: 'gpt-4o-mini',
      usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
    },
    {
      spanId: 's2',
      parentSpanId: 's1',
      name: 'search_docs',
      kind: 'tool',
      startTime: new Date().toISOString(),
      attributes: { query: 'refunds' },
    },
  ],
});

// Later, add another span to the same trace:
await hub.traces.ingest({ traceId, spans: [{ spanId: 's3', parentSpanId: 's1', name: 'finalize', kind: 'chain', startTime: new Date().toISOString() }] });
```

`kind` is one of `llm | tool | retrieval | embedding | agent | chain | other`;
`status` is one of `ok | error | unset`. `input`/`output` are stored only when
your team has payload capture enabled (or you pass `capturePayloads: true` on the
trace). Up to 200 spans per call.

### When automatic traces are sent

`traces.ingest()` above is awaited — you get the `traceId` back. The **automatic**
reports from `gateway.chat()`, `gateway.stream()`, and `gateway.runToolLoop()` aren't: they go
onto a background queue so a model call never waits on telemetry. There's no
batching timer either — an idle client sends each span as soon as it's
recorded, grouping into one request only while another is already in flight.

Two situations need one extra line:

```typescript
// Reading the traces API back straight after a call
const result = await hub.gateway.chat({ model, messages });
await hub.gateway.flush();                       // wait for the spans to be written
const { trace } = await hub.traces.get(result.gateway.traceId!);

// A long-running server, in the shutdown path you already have
await hub.gateway.close();                       // flush, then stop accepting spans
```

`close()` is idempotent, and `await using hub = new AcruxCore(...)` does the same on
Node 20.4+. A script that finishes and exits needs neither: the SDK flushes as the
process winds down. It installs **no** `SIGINT`/`SIGTERM` handlers, because doing so
suppresses Node's default terminate behaviour and would break Ctrl-C in your
application — so a process killed by a signal drops whatever spans were buffered.

## Feedback

Attach a rating, a label, and/or a comment to a trace (or to one span within
it) — the same feedback your team can leave from the dashboard's trace detail
page, but from code (e.g. surfacing an end-user's thumbs-up/down):

```typescript
const feedback = await hub.traces.submitFeedback({
  traceId,
  rating: -1,               // -1..5
  label: 'wrong_answer',
  comment: 'The tool call missed relevant docs.',
  source: 'end_user',       // 'user' | 'developer' | 'end_user' | 'api', defaults to 'user'
});

// Scope feedback to one span instead of the whole trace:
await hub.traces.submitFeedback({ traceId, spanId: 's1', rating: 5 });

// Edit it later — only the original author's feedback can be edited;
// omitted fields keep their existing value:
await hub.traces.updateFeedback({ traceId, feedbackId: feedback.id, rating: 1 });
```

At least one of `rating`/`label`/`comment` is required per call.

## Reading traces back

`traces.ingest()` only writes. To read a trace back — e.g. to show a user their own
agent run, or to pull usage/cost after the fact — use `traces.get()` (one trace,
full span tree) or `traces.list()` (a filtered, paginated list):

```typescript
const { trace, spans } = await hub.traces.get(traceId);
console.log(trace.status, trace.totalCostUsd, trace.totalTokens);
console.log(spans[0].model, spans[0].latencyMs);

const { data } = await hub.traces.list({ sessionId: 'tokyo-trip-plan-01', limit: 10 });
```

## Configuration

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `apiKey` | `ACRUXCORE_API_KEY` | **required** | Your acruxcore API key |
| `baseUrl` | `ACRUXCORE_BASE_URL` | **required** | API base URL (e.g. `http://localhost:3001/api/v1`) |
| `cacheTtl` | — | `60000` (60s) | Milliseconds before a cached result is considered stale. `0` disables caching |
| `maxCacheSize` | — | `500` | Maximum number of prompt entries in the in-process LRU cache |
| `maxRetries` | — | `1` | Retry attempts on transient failure (2 total attempts) |
| `retryInterval` | — | `500` | Milliseconds between retries |

**Create one instance at process startup and reuse it.** The cache is a module-level singleton; `maxCacheSize` is set by the first constructor call.

## Error Handling

```typescript
import { acruxcoreError } from '@acruxcoreai/sdk';

try {
  const messages = await hub.prompts.render('my-prompt', 'production', vars);
} catch (err) {
  if (err instanceof acruxcoreError) {
    switch (err.code) {
      case 'MISSING_VARIABLES':
        // Template requires variables you didn't supply
        console.error('Missing template variables:', (err.body as { error: { missing: string[] } }).error.missing);
        break;
      case 'NETWORK_ERROR':
        // API unreachable — no stale cache entry available
        console.error('acruxcore API unreachable. Check ACRUXCORE_BASE_URL.');
        break;
      case 'API_ERROR':
        // Non-retryable HTTP error (401 invalid key, 404 prompt not found, etc.)
        console.error(`acruxcore API error ${err.statusCode}`);
        break;
    }
  }
  throw err;
}
```

## Caching

The SDK maintains an in-process LRU cache:

- **Cache key:** `${apiKey}:${promptName}:${alias}:${variablesHash}` — scoped per team, per prompt, per alias, per set of variables. Rendering the same prompt with new variables always re-renders; the variable hash is independent of key order, so `{ a, b }` and `{ b, a }` share one entry.
- **Turning it off:** `cacheTtl: 0` disables caching completely — every `prompts.render` call goes to the API and nothing is stored (so the serve-stale-while-offline behaviour below no longer applies).
- **Stale-while-revalidate:** On a stale hit, the cached value is returned immediately and a background refresh fires in the background.
- **API unreachable + stale entry:** Serves the stale value and logs: `[acruxcore] Background refresh failed for "name/alias" — continuing to serve stale`.
- **API unreachable + cold cache:** Throws `acruxcoreError` with `code: 'NETWORK_ERROR'` after exhausting retries.

## Requirements

- Node.js 18+ (uses native `fetch`)
