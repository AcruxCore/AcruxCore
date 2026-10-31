# Changelog — `@acruxcoreai/sdk`

All notable changes to the TypeScript SDK. This package follows
[semver](https://semver.org/spec/v2.0.0.html) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Entries are kept short on purpose: no bullet or migration step runs past three lines.

Platform-wide changes (API, dashboard, docs) are summarised weekly on the public
changelog: <https://docs.acruxcore.com/changelog>
(source: [`apps/docs/src/pages/changelog.md`](../../apps/docs/src/pages/changelog.md)).

## Unreleased

## 0.20.0 — 2026-10-31

### Added

- `traces.list({ errorType, errorCode, hasWarning, tags, metadata })` sends the filters `GET /traces`
  already took, so a script can pull the failed, warned or tagged runs the dashboard shows.
  `hasWarning: false` is sent too: it finds runs with no warning. `SpanErrorType` is exported.
- `experiments.runLocal(datasetId, { ..., promptOverrides: { 'support-agent': 7 } })` pins a prompt
  version for one run: `prompts.render` and `prompts.getByAlias` of that prompt return v7 inside it.
- `pinPrompts({...}, fn)` pins the same way around any async function of your own.
- `pinnedVersion(name)` reads the current pin, for an app that renders the prompt another way, such
  as a gateway request with a `prompt` reference, which the server renders and no pin reaches.
- A pinned render throws `API_ERROR` when the server renders another version, which a server
  older than pinned renders does, instead of quietly running the alias's version.
- A pinned `getByAlias` still sends the alias, so a misspelled alias fails as it does on render,
  and throws `API_ERROR` when the server returns another version.
- `experiments.compareLocal(datasetId, { task, variants })` runs one local run per variant at the
  same time and resolves to a `LocalComparison` with each run and `compareUrls`.
- `experiments.judge(model, { judgePromptId, judgePromptVersion, name })`: an LLM judge scorer for
  local runs. It grades on the server with the run's criteria and overall feedback;
  `judgePromptVersion` grades with that exact version of the judge prompt in every run.
- `traces.listFeedback({ rating, promptId })` keeps only feedback with that rating, or on traces
  that ran a version of that prompt.
- `runs.commitCandidate(runId, candidateId)` commits an optimizer candidate as a version without
  moving an alias. Returns `CommitCandidateResult`; `CandidateDetail.versionNumber` reports it.
- `StartOptimizeParams.optimizerModel` chooses the model that drafts the rewrites.
- `RunDetailDto.datasetId`.

### Fixed

- A failed `prompts.render` now carries the server's reason in its message, as every other call
  does. A pin to a version that does not exist read only `API error 404 for "name/alias"`; it
  now ends with `Version 999 not found for prompt "name"`.

## 0.19.0 — 2026-10-22

### Added

- `RunDetailDto.optimizerRejections` and `RunReport.optimizerRejections`: on an optimize run, why
  each rewrite the optimizer wrote but the run dropped was dropped. Optional.
- `StartOptimizeParams.judgePromptId`: grade an `optimize.start` run with one of your prompts
  instead of the built-in judge, as `experiments.create` already allows. Optional.
- `RunReportCell.erroredCount` and `RunReportCell.unscoredReason` (`{ message, count }`): how many
  examples errored, and the commonest reason the cell's examples have no score. Both optional.
- `RunReport.unscoredReason` (`{ message, count }`): the commonest reason a result has no score,
  counted over the whole run rather than taken from each cell's top reason. Optional.
- `runs.rejudge(id, { onlyUnscored })` sends a finished run's outputs back to its judge without
  calling the models again. Returns `{ runId, status, rejudging }`. New `RejudgeRunResult` type.
- `ToolSyncResult.versionId` and `ResolvedTool.versionId`: the id of the tool version. Optional,
  since an older server does not send them.

### Fixed

- A tool span from a tool your own code ran (`tools: [...]`, or `toolRefs` with `clientTools` or
  `dispatch`) recorded `toolVersionId` as `<toolId>:<versionNumber>`. It now records the version's
  id, the same value an `http` tool span carries. Against an older server the attribute is left out.

## 0.18.0 — 2026-10-17

### Added

- `traces.analytics()` returns `costPerTrace: { p50, p99 }`, the median and p99 cost of one trace
  in the window. Optional in the type, since older servers do not send it.
- `traces.analytics({ groupBy: 'span_name' })` gives one bucket per step name inside your traces;
  the `groupBy` type now accepts it.
- `experiments.create` takes an optional `judgePromptId`: a prompt of yours that grades instead of the
  built-in judge. Each run uses its `production` version (else its latest).
- Typed judge fields: `ExperimentDto.config.judgeModel` and `judgePromptId`, each run's
  `judgeModel` and `judgePromptVersionId`, and `RunReport.judge` (the judge that graded the run).
- `RunReport.variants[].versionNumber`: the version behind each variant, so a `production`
  baseline can be shown as "v1 (production)".
- `reasoningEffort` on `chat`, `stream`, `runToolLoop` and `runPromptWithTools`, sent as
  `reasoning_effort` on the gateway and BYO paths alike. New `ReasoningEffort` type.
- `ChatUsage.cachedTokens` and `ChatUsage.reasoningTokens`, read from the gateway's flat `usage` or a
  provider's `*_tokens_details`. Set only when the provider reports more than zero.
- `IngestSpan.usage.cachedTokens`, for spans you report yourself.
- `experiments.runLocal(datasetId, { task, scorers, name })` runs your own app code over a dataset
  and stores it as one run (kind `local`) under Evaluation → Runs. Scorers return 0–1 (bool, number,
  `Score` or `Score[]`); the SDK sends 0–100. Each example gets a trace; pass `ctx.trace` to the gateway.
- A task or scorer that throws is recorded (errored result, or a null score with the error as its
  reason) and never stops the run. Results upload as they finish (20 at most per call, under 800 KB,
  and at least once a minute); the run is always finished. `ctx.history` holds a session's earlier turns.
- `AddExampleParams.expected` and `DatasetExampleDto.expected`: a structured reference answer for
  code scorers. Run cells carry `expected` and named `scores`; report cells carry `namedScores`.
- `RunKind` (`'evaluation' | 'optimize' | 'local'`) on `RunListItemDto.kind` and `RunDetailDto.kind`.
  New types: `RunLocalOptions`, `LocalRunResult`, `Scorer`, `Score`, `LocalTaskContext` and friends.
- `traces.step(name, options?, fn)` runs `fn` as one span of your own code; `traces.wrap(name, options?, fn)`
  makes every call of a function one. Steps nest, and `chat()` / `stream()` inside a step land under it
  on both paths. New types `Step`, `StepOptions`. [Why](../../docs/superpowers/specs/cross-cutting/sdk-faq.md)
- `traces.wrap` on a generator function keeps the step open until the generator ends, and makes it the
  open step only while the generator's own code runs. A step still open when its root ends is sent then.
- A wrapped generator dropped part-way, without `return()`, has its step closed when it is
  garbage-collected, so its trace is still sent and freed.
- A step joins only calls made on the client that opened it; another client's call inside it starts
  its own trace. One trace holds at most 1,000 spans; the rest are dropped and counted as
  `droppedSpans` on the root span.
- `prompts.getByAlias(name, alias)` returns the version an alias points at, template unrendered. Cached
  for `cacheTtl`, up to `maxCacheSize` entries; each call returns its own copy.
- A `getByAlias` miss is one request, `GET /prompt-versions?name=&alias=`. Against a server without
  that endpoint it falls back to three (find the prompt, read its aliases, read the version).
- `extraBody` on `chat` and `stream` adds more OpenAI fields (`top_p`, `seed`, …) on both paths.
  A key another option already sets, or `model` / `messages` / `stream`, throws `VALIDATION_ERROR`.
- `trace.parentSpanId` puts a call's `llm` span under a span you reported: `x-parent-span-id` on the
  gateway path, `parentSpanId` on a BYO span.

### Changed

- **`experiments.create` and `optimize.start` now require `judgeModel`.** The server no
  longer picks the judge for offline runs; name a model registered under Gateway → Models.
  Sent as `judge_model`. [Why](../../docs/superpowers/specs/phase-5/phase-5-faq.md)

  **Migrating from 0.17**

  1. Add `judgeModel: '<registered model name>'` to every `experiments.create({ … })` and
     `optimize.start(promptId, { … })` call.
  2. TypeScript catches a miss at compile time (`Property 'judgeModel' is missing`).
     JavaScript callers must grep for both calls; without it the API answers 400.

- Tool spans from `runToolLoop` have ids like `tool-0-0-1a2b3c4d5e6f`, not `tool-0-0`. Two loops
  reporting to one trace reused the short ids, and the server kept only the first loop's spans.
- **A feedback `rating` is a thumb: `1` (up) or `-1` (down).** The API refuses any other number
  with a 400. `FeedbackInput.rating` and `FeedbackUpdateInput.rating` are now the new
  `FeedbackRating` type (`1 | -1`). [Why](../../docs/superpowers/specs/phase-3/phase-3-faq.md)

  **Migrating from 0.17**

  1. Map a score to a thumb before `submitFeedback` / `updateFeedback`, for example
     `rating: stars >= 4 ? 1 : -1`, or leave `rating` out and keep the score in `label`.
  2. TypeScript catches a literal like `rating: 5` at compile time. A `number` variable
     also fails to compile; JavaScript callers only see the 400 at runtime, so grep for them.

### Fixed

- BYO-provider spans now report `cachedTokens` to `/traces`, so cached prompt tokens are priced at the
  cached input rate. Before, every prompt token on a traced BYO call was billed at the full rate.
- Two `runToolLoop` calls with the same `trace: { traceId }` lost the second loop's tool spans: their
  ids repeated the first loop's. Each tool span id is now unique.
- A `traces.ingest(…, { wait: false })` report with `capturePayloads: false` could be merged with
  another queued report for the same trace and lose the flag, so its payloads were stored anyway.
- Leaving a stream early with `break` now closes its connection at once. It stayed open until the
  response body was garbage-collected.
- A BYO `chat()` / `stream()` call now names its trace from `trace: { name }`, as the gateway path does.
  It was always `'chat'`.
- A BYO call (`chat`, `stream` and both tool loops) now sends `trace.tags` and `trace.metadata` with
  its spans, as the gateway path does. They were dropped, so a tag filter missed every BYO call.
- A BYO stream (or a streamed BYO tool loop) left early with `break` now reports its `llm` span with
  what arrived, `status: 'ok'` and `attributes.clientClosed: true`. It wrote no span at all.

## 0.17.0 — 2026-10-13

### Added

- `ContentPart`, `TextPart` and `ImagePart` types. A `user` `Message` and a `PromptMessage` can hold a
  list of text and image parts, so a typed call can send an image or commit a prompt with one.
- `AssistantMessage`, the type of a reply: its `content` is `string | null`, as before.

### Changed

- `Message.content` is now `string | ContentPart[] | null`, and `PromptMessage.content` and a prompt
  version's `messages[].content` are `string | ContentPart[]`. This is a type-only change.

### Fixed

- Under `moduleResolution: "nodenext"`, an ES module read the CommonJS declarations, so
  `new AcruxCore()` failed with TS2351. `import` and `require` now each get their own declarations.

### Migrating from 0.16

1. Code that reads `content` from a prompt version, a rendered prompt or a message you sent must narrow
   it first, for example `typeof m.content === 'string'`. The compiler reports each place.
2. A reply (`ChatResult.message`) is an `AssistantMessage`, so its `content` is still `string | null`.

## 0.16.0 — 2026-10-10

### Added

- `datasets.addExamples(datasetId, examples)` imports up to 500 examples in one call
  (`POST /datasets/:id/examples/bulk`) and returns `{ added, exampleCount }`. One
  invalid row rejects the whole call with a 400 that names the row; nothing is written.
- `cache_control?: CacheControl` on `Message` and `PromptMessage`, and the exported
  `CacheControl` type. Set `{ type: 'ephemeral' }` to cache the prompt up to that message
  on an Anthropic model; the gateway drops it for other models.

- `RunCellExampleDto.errorMessage` — the reason a cell produced no output, matching
  what `GET /runs/:id/cells/:cellKey` has returned since the failed-cell fix. A
  TypeScript consumer reading it no longer gets a compile error.

### Fixed

- `datasets.create({ name, overallFeedback })` now saves `overallFeedback`. The SDK sent it
  in camelCase, which the API ignores, so the dataset was created with no overall feedback.

- A streamed completion that fails after its first byte now raises `acruxcoreError`
  with code `API_ERROR` and the gateway's own message, instead of a bare `TypeError`
  from reading `choices[0]` on an error frame.

## 0.15.0 — 2026-09-14

### Added

- `ToolDetail` now carries `callable`, `versionCount`, `latestVersionNumber`, `executorType`
  and `aliases` — the same readiness fields the API's `tools.list()`/`tools.get()` already
  return. `ToolAliasTarget` is exported for the shape of an `aliases` entry.
- `ToolExecutor`'s `http` variant gained `failureWhen`, `resultSchema` and
  `resultSchemaSeverity`, matching what `tools.commitVersion()` already accepts.

### Changed

- `gateway.runPromptWithTools()` warns when you pass `clientTools`, `dispatch` or `tools`
  and the prompt has no tools bound. The run is still a plain completion, as before — but
  the function you handed over is never called, and nothing used to say so.
- **Breaking.** `ToolDetail` gained five required fields (`callable`, `versionCount`,
  `latestVersionNumber`, `executorType`, `aliases`). Code that only reads a `ToolDetail`
  returned by `tools.get()` / `tools.list()` is unaffected; code that *constructs* one — a
  test fixture, a stub, a fake client — no longer compiles.

  **Migrating from 0.14**

  1. Build and read the errors: `tsc` reports every literal that is missing the new fields,
     at the exact line. There is no rename and no call-signature change.
  2. Supply the five fields. A versionless tool is
     `{ callable: false, versionCount: 0, latestVersionNumber: null, executorType: null, aliases: [] }`.

  TypeScript catches this at compile time, so nothing here can reach production unnoticed.

### Fixed

- `gateway.chat({ tools: [...] })` now rejects a tool declared with `acrux.tool` before
  sending anything, naming the tool and pointing at `runToolLoop`. It used to travel and
  come back as the server's `400 Invalid literal value, expected "function"`.
- The no-tools-bound warning above could fire even when `tools` or `toolDefs` already gave
  the model something to call — it read only the prompt's own bindings. It now fires only
  when the run truly offers the model nothing.

## 0.14.0 — 2026-09-14

### Added

- `gateway` on `gateway.chat()`, `gateway.stream()`, `gateway.runToolLoop()` and
  `gateway.runPromptWithTools()` — the per-call gateway controls `{ maxRetries, fallback }`,
  which until now could only be sent by leaving the SDK and writing the HTTP request by hand.
- `GatewayControl` is exported for typing that object.
- `toolError(type, message, result?)` and `toolWarning(type, message, result?)` — return one
  from a client-side tool when only your code can tell a 200 response is really a failure.
  The span records it; the loop keeps going and the model still reads `result`.
- `type` lands on the span as `errorCode`, beside the closed-vocabulary `errorType`, so a
  failure mode you name yourself stays matchable. A warning's `type` is that slug too.
- Client-side tools are now checked against the catalog's `resultSchema` when the resolved
  version declares one. A mismatch is a warning unless the version sets `resultSchemaSeverity`.
- `error` and `warning` on the result of `tools.execute()`, carrying the platform's own
  classification of a server-side tool call.
- `resultSchema` / `resultSchemaSeverity` on `ResolvedTool`.

### Changed

- The client's own `maxRetries` is documented as what it is: a retry of this SDK's request
  to AcruxCore. Use the per-call `gateway.maxRetries` to change how many times a *provider*
  is called. Neither affects the other; nothing about the existing setting changed.
- A call made with the per-call `gateway` controls now shows in its trace whether it was
  retried or served by a fallback model, and which model finally answered. The failing
  attempt's own provider message is recorded beside its status. No SDK change is needed.
- `ToolExecutor.argMapping` is optional now, and it and `bodyTemplate` are deprecated.
  Neither was ever applied to the request, and the API rejects a commit carrying a non-empty
  one. Bind an argument with `{{arg.NAME}}` in a query value, a header value or the URL.

### Fixed

- Tool spans are no longer lost when a later round of `runToolLoop` throws. They were only
  reported on the paths that remembered to flush, so a provider error mid-loop produced a
  trace showing a run that called no tools at all.

## 0.13.0 — 2026-09-13

### Added

- `promptId` on `traces.list()`. Matches traces using ANY version of a prompt, where
  `promptVersionId` matches one exact version.
- `qIn` on `traces.list()` — narrows `q` to `'input'`, `'output'` or `'name'`. `q` now
  also searches the captured request and response, not only names and attributes.
- `TraceSearchScope` is exported for typing a `qIn` value.
- `variables` on `gateway.chat()`, `gateway.stream()` and `gateway.runToolLoop()`. Sent
  as the gateway's top-level `variables`, and recorded on the `llm` span so feedback on
  the run can become an evaluation dataset example.
- `gateway.runPromptWithTools(rendered)` now forwards the render's variables for you,
  the same way it already derives the model, messages, tool refs and `promptVersionId`.
- `RenderResult.variables` echoes what `prompts.render()` was called with, so a caller
  holding only the result can still pass the lineage on.
- `IngestSpan.variables` for a self-reported `llm` span. The API has always accepted it;
  the type never exposed it.

### Changed

- `RenderResult` now has a required `variables` field. Reading a render result is
  unaffected; only code that builds a `RenderResult` by hand (usually a test double) has
  to add it.

#### Migrating from 0.12

1. If you construct a `RenderResult` yourself, add `variables: {}` (or the real values).
   The compiler catches this — `Property 'variables' is missing`.
2. If you call the gateway with `promptVersionId` and rendered the prompt yourself, add
   `variables` too. Nothing breaks without it, but the run cannot seed a dataset, so grep
   for `promptVersionId` and pair each one up.

### Fixed

- A tool declared with no `description` now reaches a BYO provider with the catalog's
  description. `runToolLoop`/`runPromptWithTools` with `provider` inlined the local
  schema, so the model saw the tool with no description at all and nothing reported it.
- Only an undescribed tool costs the extra `POST /tools/resolve`; a described one and the
  gateway path are unchanged, since the gateway already resolves `toolRefs` itself.
- A tool described neither in code nor in the catalog now warns on the BYO path, instead
  of being sent with nothing telling the model when to call it.

## 0.12.0 — 2026-09-07

### Added

- `register({ instrument: ['langchain'] })` in `@acruxcoreai/sdk/otel`. Traces LangChain
  and LangGraph agents to AcruxCore over OTLP, matching the Python SDK's `langchain`
  instrumentor. Needs `@arizeai/openinference-instrumentation-langchain` installed.
- One instrumentor covers the whole framework: it patches LangChain's `CallbackManager`,
  so chain, LLM, tool and retriever spans all report. Do not add `'openai'` alongside it
  for a `ChatOpenAI` model — the model call is then reported twice, once inside the agent
  trace and again as a separate single-span trace, double-counting its tokens and cost.

## 0.11.0 — 2026-09-06

### Added

- `FeedbackBucket.label` and `FeedbackBucket.promptId` on
  `traces.getFeedbackSummary()`. `label` is the readable bucket name — the model, or
  `"<prompt name> v<n>"` for a prompt version; `promptId` is the owning prompt, null
  when grouped by model.
- `key` is unchanged and still the raw grouping value, so anything mapping a bucket
  back to a version id keeps working.
- `experiments.delete(id)` and `runs.delete(id)`. Deleting an experiment takes its runs
  with it; deleting a run leaves the experiment and any optimizer candidates it drafted.
- Both throw a 409 `RUN_IN_FLIGHT` error while a run is still queued or running — the
  worker is mid-flight, so finish first, then delete.
- `traces.ingest(input, { wait: false })`: buffers the trace in the client's span queue —
  the same one the gateway reports through — and returns immediately, so instrumenting a
  retrieval or rerank step costs no round trip.
- The returned `traceId` is generated client-side in that mode and is usable at once: the
  ingest endpoint creates the trace under it, so it can go straight into
  `gateway.chat({ trace: { traceId } })`.
- `traces.flush()`: waits for everything buffered (yours and the gateway's) to be sent.
  Call it before reading a trace back or before a short-lived process exits.

### Changed

- Nothing by default. `wait` defaults to `true`, which is the existing behaviour: one
  awaited POST, errors thrown at the call site, the server's trace id in the result. With
  `wait: false` a failed send warns once per error kind and drops the batch instead.

## 0.10.0 — 2026-08-21

### Added

- `prompts.listAliases(promptId)`: the read half of `promoteAlias`, answering "which
  version is `production` on right now?" without hand-building an HTTP call. Returns one
  `AliasDetail` per alias, or an empty array for a prompt with no committed version.
- `clientTools` on `gateway.runToolLoop` and `gateway.runPromptWithTools`: a
  `{ toolName: fn }` map that runs a catalog tool whose executor is `client`, without
  the hand-written `dispatch` router that was previously the only way.
- Unlike `tools: [declared]`, it writes nothing to the catalog: the tool's definition,
  its binding's alias or pin, and the `toolVersionId` stamped on the tool span all stay
  the catalog's. Each function receives one arguments object.
- A bound `client` tool with no runner still throws `MISSING_DISPATCH` before the first
  model call, and the message now lists the `clientTools` keys that were supplied — which
  is how a mistyped key shows itself.

### Changed

- An `http` tool named in `clientTools` is ignored in silence. The platform runs it, and
  one map is meant to serve prompt aliases whose executor differs — `production` on
  `http`, `staging` on `client`.
- `dispatch` is unchanged and not deprecated. It stays the right input for a tool set
  whose names are only known at runtime.

### Fixed

- `gateway.chat()` on the gateway path no longer reports an `llm` span of its own. The
  gateway already writes that span, so any `trace` value but `false` counted every model
  call twice — wrong span counts, wrong per-trace token totals, and nothing errored.
- `gateway.chat({ trace: { name } })` now reaches the gateway. The key worked on
  `runToolLoop` and was silently dropped here; `traceId` and `sessionId` in the same
  object were dropped too, so a `chat()` could not join a trace at all.
- A tool loop that joins an existing trace (`trace: { traceId }`) no longer renames it to
  `runToolLoop`. The default name is still sent for a trace the loop opens, and an
  explicit `name` still wins either way. The default now travels on the API's new
  `x-trace-name-if-unset` channel, so the server enforces this rather than trusting the
  client — see the gateway reference.
- An error raised for a BYO provider call now carries the provider's own reason. Both
  `gateway.chat` and its streaming path said only `provider returned 400 calling chat
  completions` while the cause sat unread on `err.body`.

- A call with no model now fails in the SDK with `VALIDATION_ERROR` instead of being sent.
  A BYO provider reads an absent model as licence to pick its own default and then rejects
  it, so the thrown error named a model the caller never wrote.
## 0.9.0 — 2026-08-20

### Added

- New `gateway.runPromptWithTools(rendered, options?)`: takes a `render()` result and
  derives `model`, `messages`, `toolRefs` and `promptVersionId` from it, so a call
  site no longer restates any of them. Any option passed wins over the derived value.
- **`stream: true` on `gateway.runToolLoop` (and on `runPromptWithTools`)** yields an
  async iterable of typed `ToolLoopEvent`s — `content` / `tool_call` / `tool_result` /
  `done` — instead of awaiting the whole loop. The trace is identical to a
  non-streamed run: one `llm` span per round, with the round's tool spans under it.
- `toolRefs` entries (and `tools.resolve` refs) accept `version` to pin one exact
  tool build instead of following an alias. A binding pinned on the platform now
  travels as a pin through `runPromptWithTools`, rather than as its alias.
- `ChatChunk.delta` now declares `tool_calls`. The gateway has always forwarded
  those fragments; the type omitted them, so a hand-rolled streaming tool loop
  needed a cast to see them.
- New exported types `ToolLoopEvent`, `ToolRef` and `RunPromptWithToolsOptions`.
- `prompts.render()` now also returns `toolResolutions` — per-tool metadata (the
  alias or pin actually resolved, its version number, and which binding decided
  it) alongside the existing `tools` array.
- New `withToolOverride(rendered, { name, alias })` helper: overrides one bound
  tool's alias for a single `gateway.chat()`/`runToolLoop()` call. Handles the
  tools/toolRefs name-collision removal for you and warns (naming the prompt's
  current setting) when the tool was already bound, so the override doesn't
  read as the prompt's own configuration.
- Six new prompt→tool binding methods, replacing the removed `tool-routes`
  endpoints: `prompts.listToolBindings`, `setToolBinding`, `removeToolBinding`,
  `setAliasToolBinding`, `removeAliasToolBinding`, `resetAliasToolBindings`.
- `setToolBinding` writes the default every prompt alias inherits;
  `setAliasToolBinding` gives one alias its own binding, including `{ off: true }`
  for "this alias deliberately has no such tool".
- New types `ToolBindingInput`, `AliasToolBindingInput`, `ToolBindingDetail`,
  `AliasToolBindings`, `PromptToolBindings`, and a `VALIDATION_ERROR` error code
  for a binding the SDK rejects before sending.

### BREAKING

- **`commitVersion` no longer takes `tools`.** A version decides the template
  only; tools are bound per prompt alias. `AttachToolInput` is removed with it.
  1. *Migrating from 0.8:* delete the `tools: [...]` property from every
     `prompts.commitVersion(id, { ... })` call, and replace each entry with
     `await hub.prompts.setToolBinding(promptId, toolId, { toolAlias })` (or
     `{ pinnedVersionNumber }`) — once per tool, not once per commit.
  2. The compiler catches this: `tools` is an excess property on
     `CommitVersionInput`, and `AttachToolInput` no longer resolves as an import.
- **The `tool-routes` endpoints are gone** —
  `PUT`/`DELETE /prompts/:id/aliases/:alias/tool-routes/:toolId` and
  `/prompts/:id/tool-routes` return 404. The binding endpoints replace them.
  1. *Migrating from 0.8:* swap any raw request to
     `PUT /prompts/:id/aliases/:alias/tool-routes/:toolId` for
     `prompts.setAliasToolBinding(promptId, alias, toolId, { toolAlias })`, and
     the matching `DELETE` for `prompts.removeAliasToolBinding(...)`.
  2. Nothing catches this for you: no SDK method ever wrapped those paths, so
     grep your code for `tool-routes` — a stale caller fails at runtime with a 404.

### Changed

- **`toolResolutions[].overridden` (boolean) is now `source: 'alias' | 'default'`.**
  `'alias'` means the prompt alias had a binding of its own, `'default'` that it
  inherited the prompt's default.
  1. *Migrating from 0.8:* replace `r.overridden` with `r.source === 'alias'`.
     The old `true` and the new `'alias'` do not mean the same thing — `true` used
     to mean "a live override outranked the version's attachment", a distinction
     the single binding table no longer has.
  2. The compiler catches this: `overridden` is gone from `ToolResolution`, so
     reading it is an error rather than a silently `undefined` (falsy) value.
- **`promptVersionId` now actually reaches the gateway.** It used to be stamped only
  on client-written spans, so on the gateway path — where the gateway writes the
  `llm` span — passing it did nothing and the span had no link back to the prompt.
  It is sent as `prompt_version_id` on the request body now, and never to a BYO
  provider. Needs an API deployed on 2026-08-20 or later; an older one ignores the
  field, exactly as before.
- `withToolOverride`'s warning now names which binding holds the current setting
  ("the prompt's default binding" / "this prompt alias's own binding") instead of
  saying "via a routing override". Same helper, same name, same behaviour.

## 0.8.0 — 2026-08-11

### Added

- New `@acruxcoreai/sdk/otel` subpath export: `register()` collapses the
  `NodeTracerProvider` + `BatchSpanProcessor` + `OTLPTraceExporter` wiring every
  OTLP integration needs into one call, with `instrument: ['openai', 'openai_agents']`
  to turn on a framework's own OpenInference instrumentor. `@opentelemetry/*`
  packages are new optional peer dependencies — install them only if you use this.
- `SUPPORTED_FRAMEWORKS` export lists the frameworks `instrument: [...]` accepts.
  See [Send OTel traces to AcruxCore with the SDK
  helper](https://docs.acruxcore.com/docs/guides/send-otel-traces-with-the-sdk-helper)
  for worked examples: a bare pipeline, one framework, session grouping, and wiring
  an unsupported framework (e.g. LangChain.js) by hand.

## 0.7.1 — 2026-08-07

### Changed

- The product name is now written as one word, "AcruxCore", in the package
  description and in every doc comment.
- No API, behaviour, or type changes. Upgrading from 0.7.0 needs no code edits.

## 0.7.0 — 2026-08-05

### BREAKING

- **Resource-based namespace pattern.** All flat client methods removed — use `hub.gateway.*`, `hub.prompts.render()`, `hub.traces.*` instead.
  - `hub.chat(...)` → `hub.gateway.chat(...)`
  - `hub.chat({stream: true, ...})` → `hub.gateway.stream(...)`
  - `hub.runToolLoop(...)` → `hub.gateway.runToolLoop(...)`
  - `hub.flush()` / `hub.close()` → `hub.gateway.flush()` / `hub.gateway.close()`
  - `hub.renderPrompt(...)` → `hub.prompts.render(...)`
  - `hub.trace(...)` → `hub.traces.ingest(...)`
  - `hub.getTrace(...)` → `hub.traces.get(...)`
  - `hub.listTraces(...)` → `hub.traces.list(...)`
  - `hub.submitFeedback(...)` → `hub.traces.submitFeedback(...)`
  - `hub.updateFeedback(...)` → `hub.traces.updateFeedback(...)`

### Added

- **`GatewayNamespace`** — new class at `src/gateway-api.ts` consolidating all gateway operations (chat, stream, runToolLoop, flush, close).
- **`hub.prompts.render()`** — replaces `renderPrompt()` with built-in SWR cache.
- **Trace CRUD on `hub.traces`** — `ingest`, `get`, `list`, `submitFeedback`, `updateFeedback`.
- **`NamespaceHost` / `GatewayNamespaceHost` interfaces** — shared host contract (`src/host.ts`), all existing namespace host interfaces now extend it.
- **`hub.traces` and `hub.sessions` namespaces.** Trace analytics, facet
  discovery, payload-capture settings, feedback summary/list, and session
  listing — ten endpoints that previously had no SDK binding.

  ```ts
  const stats = await hub.traces.analytics({ groupBy: 'model' });
  const facets = await hub.traces.listFacets();
  const sessions = await hub.sessions.list({ limit: 20 });
  ```
- **`hub.prompts` — prompt version lifecycle.** New namespace: create/read/update/delete
  prompts, commit immutable versions, list/get them, diff two versions, promote
  aliases, export/import versions, and look up a version's traces.

  ```ts
  const prompt = await hub.prompts.create({ name: 'support-agent' });
  const version = await hub.prompts.commitVersion(prompt.id, {
    messages: [{ role: 'system', content: 'You are a helpful support agent.' }],
  });
  await hub.prompts.promoteAlias(prompt.id, 'production', version.versionNumber);
  const traces = await hub.prompts.tracesForVersion(prompt.id, version.versionNumber);
  ```
- **Tool catalog lifecycle via SDK.** `hub.tools` gained management for tool shells
  (`create`, `list`, `get`, `update`, `delete`), versions (`commitVersion`,
  `listVersions`, `getVersion`), alias promotion (`promoteAlias`), and analytics.
- Evaluations domain: `hub.datasets`, `hub.experiments`, `hub.runs`, `hub.optimize` — 19 methods covering the full evaluations API (datasets, experiments, runs, prompt optimization).

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

1. If you `gateway.chat()` and then **read the traces API back** — in a test, or code polling for the
   span it just produced — insert `await hub.gateway.flush()` between the two. **Nothing in the type
   system catches this**: grep for reads of `/traces` following a `gateway.chat()` or `gateway.runToolLoop()`.
2. If your process is a **long-running server**, call `await hub.gateway.close()` in the shutdown path
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
