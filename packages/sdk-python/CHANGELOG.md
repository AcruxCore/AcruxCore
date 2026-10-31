# Changelog — `acruxcore`

All notable changes to the Python SDK. This package follows
[semver](https://semver.org/spec/v2.0.0.html) and
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Entries are kept short on purpose: no bullet or migration step runs past three lines.

Platform-wide changes (API, dashboard, docs) are summarised weekly on the public
changelog: <https://docs.acruxcore.com/changelog>
(source: [`apps/docs/src/pages/changelog.md`](../../apps/docs/src/pages/changelog.md)).

## Unreleased

### Added

- `traces.list(error_type=, error_code=, has_warning=, tags=, metadata=)` sends the filters
  `GET /traces` already took, so a script can pull the failed, warned or tagged runs the dashboard
  shows. `has_warning=False` is sent too: it finds runs with no warning.
- `error_type` is typed `SpanErrorType` (exported), so a typo fails the type check. `tags="prod"`
  is one tag; a plain string is not split into letters.
- `experiments.run_local(..., prompt_overrides={"support-agent": 7})` pins a prompt version for
  one run: `prompts.render` and `prompts.get_by_alias` of that prompt return v7 inside it.
- `pin_prompts({...})`, a context manager that pins the same way around any block of your code.
- `pinned_version(name)` reads the current pin, for an app that renders the prompt another way, such
  as a gateway request with a `prompt` reference, which the server renders and no pin reaches.
- A pinned render raises `API_ERROR` when the server renders another version, which a server
  older than pinned renders does, instead of quietly running the alias's version.
- A pinned `get_by_alias` still sends the alias, so a misspelled alias fails as it does on render,
  and raises `API_ERROR` when the server returns another version.
- `experiments.compare_local(dataset_id, task=..., variants={...})` runs one local run per variant
  at the same time and returns a `LocalComparison` with each run and a compare link per variant.
- `experiments.judge(model, judge_prompt_id=None, judge_prompt_version=None, name="judge")`: an
  LLM judge scorer for local runs, graded on the server with the run's criteria and overall
  feedback. `judge_prompt_version` grades with that exact judge prompt version in every run.
- `traces.list_feedback(rating=..., prompt_id=...)` keeps only feedback with that rating, or on
  traces that ran a version of that prompt.
- `runs.commit_candidate(run_id, candidate_id)` commits an optimizer candidate as a version without
  moving an alias. Returns `CommitCandidateResult`; `CandidateDetail.version_number` reports it.
- `optimize.start(..., optimizer_model=...)` chooses the model that drafts the rewrites.
- `RunDetailDto.dataset_id`.

### Fixed

- A failed `prompts.render` now carries the server's reason in its message, as every other call
  does. A pin to a version that does not exist read only `API error 404 for "name/alias"`; it
  now ends with `Version 999 not found for prompt "name"`.

## 0.19.0 — 2026-10-22

### Added

- `optimize.start(..., judge_prompt_id=...)`: grade an optimize run with one of your prompts
  instead of the built-in judge, as `experiments.create` already allows. Optional.
- `runs.rejudge(run_id, only_unscored=True)` sends a finished run's outputs back to its judge
  without calling the models again. Returns a `RejudgeRunResult` (`run_id`, `status`, `rejudging`).
- `ToolSyncResult.version_id` and `ResolvedTool.version_id`: the id of the tool version. `None`
  from an older server.
- `RunDetailDto.optimizer_rejections` and `RunReport.optimizer_rejections`: on an optimize run,
  why each rewrite the optimizer wrote but the run dropped was dropped. `None` from an older server.

### Fixed

- A tool span from a tool your own code ran (`tools=[...]`, or `tool_refs` with `client_tools` or
  `dispatch`) recorded `toolVersionId` as `<tool_id>:<version_number>`. It now records the version's
  id, the same value an `http` tool span carries. Against an older server the attribute is left out.

## 0.18.0 — 2026-10-17

### Added

- `traces.analytics()` returns `cost_per_trace` (a `CostPerTrace` with `p50` and `p99`), the median
  and p99 cost of one trace in the window. `None` from an older server.
- `traces.analytics(group_by="span_name")` gives one bucket per step name inside your traces.
- `experiments.create` takes an optional `judge_prompt_id`: a prompt of yours that grades instead of the
  built-in judge. Each run uses its `production` version (else its latest).
- `RunReport.judge` (a `RunJudge` with `model` and `prompt_version_id`) names the judge that graded
  the run. Each `ExperimentRunDto` has the same as `judge_model` and `judge_prompt_version_id`.
- `reasoning_effort` on `chat`, `stream`, `run_tool_loop` and `run_prompt_with_tools`, sent as
  `reasoning_effort` on the gateway and BYO paths alike.
- `ChatUsage.cached_tokens` and `ChatUsage.reasoning_tokens`, read from the gateway's flat `usage` or
  a provider's `*_tokens_details`. Set only when the provider reports more than zero.
- `SpanUsage` takes `cachedTokens`, for spans you report yourself.
- `experiments.run_local(dataset_id, task=, scorers=, name=)` runs your own code over a dataset
  and uploads it as a run. Scorers return a bool, a 0–1 number, a `Score`, a dict or a list.
  Returns a `LocalRunResult` with items and a per-score summary.
- `run_local`'s `primary_score` has no default: the server uses each result's first score. NaN and
  infinite floats in an output are sent as `null`. Results upload at least once a minute.
- Each local-run example gets a `chain` span in its own trace; pass `trace=ctx.trace` (a
  `LocalExample`, which also carries `history` for a session-built example) to gateway calls.
- `datasets.add_example` and `add_examples` take `expected`, any JSON reference answer for
  code scorers. `DatasetExampleDto.expected` reads it back.
- Run reads cover local runs: `RunListItemDto.kind` can be `"local"`, cell rows carry `scores` and
  `expected`, and `RunReport.cells` carry `namedScores` (all on the 0–100 scale).
- `traces.step(name, kind=)` traces your own code, as a decorator (sync or async) or a `with` block.
  Steps nest, and `chat()` / `stream()` inside a step land under it on both paths. One report per
  outermost step. [Why](../../docs/superpowers/specs/cross-cutting/sdk-faq.md)
- `AcruxCoreSync`: the same client with blocking methods, for code that is not async. Thread-safe;
  a streaming call returns a plain iterator.
- `prompts.get_by_alias(name, alias)` returns the version an alias points at, template unrendered,
  for apps that render their own. Cached for `cache_ttl`, up to `max_cache_size` entries; each call
  returns its own copy, so filling the template in place is safe.
- A `get_by_alias` miss is one request, `GET /prompt-versions?name=&alias=`. Against a server
  without that endpoint it falls back to three (find the prompt, read its aliases, read the version).
- `@traces.step` also wraps generator and async-generator functions: the step stays open until the
  generator ends, and is current only while the generator's own code runs. `send()` and `throw()`
  reach the generator as they would undecorated.
- A step joins only calls made on the client that opened it; another client's call inside it starts
  its own trace. One trace holds at most 1,000 spans; the rest are dropped and counted as
  `droppedSpans` on the root span.
- One `traces.step(...)` object may be entered again, or by several tasks at once: each entry keeps its
  own output and ids. A plain function that returns a coroutine is traced until that coroutine ends.
- A step still open when its outermost step ends (a task it started without awaiting) is sent when
  it ends, with the calls made inside it.
- `AsyncChatStream.aclose()` releases a stream read part-way. On `AcruxCoreSync`, a stream left with
  `break` is closed when dropped, or at once with `.close()` or a `with` block.
- `extra_body` on `chat` and `stream` adds more OpenAI fields (`top_p`, `seed`, …) on both paths.
  A key a named argument already sets raises `VALIDATION_ERROR`.
- `trace={"parent_span_id": ...}` puts a call's `llm` span under a span you reported:
  `x-parent-span-id` on the gateway path, `parentSpanId` on a BYO span.

### Changed

- **`experiments.create` and `optimize.start` now require `judge_model`.** The server no
  longer picks the judge for offline runs; name a model registered under Gateway → Models.
  It is keyword-only. [Why](../../docs/superpowers/specs/phase-5/phase-5-faq.md)

  **Migrating from 0.17**

  1. Add `judge_model="<registered model name>"` to every `experiments.create(…)` and
     `optimize.start(…)` call.
  2. Python catches a miss at call time (`TypeError: missing 1 required keyword-only
     argument: 'judge_model'`), so it fails in your first test run, not in production.

- Tool spans from `run_tool_loop` have ids like `tool-0-0-1a2b3c4d5e6f`, not `tool-0-0`. Two loops
  reporting to one trace reused the short ids, and the server rejected the second loop's spans.
- **A feedback `rating` is a thumb: `1` (up) or `-1` (down).** The API refuses any other
  number with a 400, raised as `AcruxCoreError` (code `API_ERROR`). `submit_feedback` types it
  as `Literal[1, -1]`. [Why](../../docs/superpowers/specs/phase-3/phase-3-faq.md)

  **Migrating from 0.17**

  1. Map a score to a thumb before `submit_feedback` / `update_feedback`, for example
     `rating=1 if stars >= 4 else -1`, or leave `rating` out and keep the score in `label`.
  2. A type checker (mypy, pyright) flags `rating=5`; Python itself does not. Grep for `rating=`
     in those two calls, since a missed one raises `AcruxCoreError` (status 400) at runtime.

### Fixed

- Two `run_tool_loop` calls with the same `trace={"trace_id": ...}` lost the second loop's tool
  spans: their ids repeated the first loop's. Each tool span id is now unique.
- A `traces.ingest(..., wait=False)` report with `capturePayloads: False` could be merged with
  another queued report for the same trace and lose the flag, so its payloads were stored anyway.
- BYO-provider spans now report `cachedTokens` to `/traces`, so cached prompt tokens are priced at the
  cached input rate. Before, every prompt token on a traced BYO call was billed at the full rate.
- A BYO `chat()` / `stream()` call now names its trace from `trace={"name": ...}`, as the gateway
  path does. It was always `"chat"`.
- A BYO call (`chat`, `stream` and both tool loops) now sends the trace's `tags` and `metadata` with
  its spans, as the gateway path does. They were dropped, so a tag filter missed every BYO call.
- A BYO stream (or a streamed BYO tool loop) closed early with `aclose()` now reports its `llm` span
  with what arrived, `status: "ok"` and `attributes["clientClosed"] = True`. It wrote no span at all.
- The `traces.ingest` docstring said `trace={"traceId": ...}`; the key `chat()` reads is `trace_id`.

## 0.17.0 — 2026-10-13

### Added

- `ContentPart`, `TextPart`, `ImagePart` and `ImageUrl` types. `Message["content"]` and
  `PromptMessage["content"]` accept a list of text and image parts, so a call can send an
  image or commit a prompt that has one. A reply's `content` is still text or `None`.

### Changed

- `Message["content"]` is now `Union[str, List[ContentPart], None]` and `PromptMessage["content"]`
  is `Union[str, List[ContentPart]]`. This is a type-only change; nothing changes at runtime.

### Migrating from 0.16

1. A type checker (mypy, pyright) reports each place that uses `content` as a `str` on a message you
   built or a prompt version you read. Narrow it first, for example `isinstance(m["content"], str)`.

## 0.16.0 — 2026-10-10

### Added

- `datasets.add_examples(dataset_id, examples)` imports up to 500 examples in one call
  (`POST /datasets/:id/examples/bulk`) and returns `AddExamplesResult(added, example_count)`.
  One invalid row rejects the whole call with a 400 that names the row; nothing is written.
- `cache_control` key on the `Message` TypedDict, and the exported `CacheControl` type.
  Set `{"type": "ephemeral"}` to cache the prompt up to that message on an Anthropic
  model; the gateway drops it for other models.

### Fixed

- A streamed completion that fails after its first byte now raises `AcruxCoreError`
  with code `API_ERROR`, instead of yielding one empty chunk and finishing cleanly —
  which reported a truncated answer to the caller as a complete one.

## 0.15.0 — 2026-09-14

### Added

- `ToolDetail` now carries `callable`, `version_count`, `latest_version_number`,
  `executor_type` and `aliases` — the same readiness fields the API's `tools.list()`/
  `tools.get()` already return. `ToolAliasTarget` is exported for an `aliases` entry.

### Changed

- `gateway.run_prompt_with_tools()` warns when you pass `client_tools`, `dispatch` or
  `tools` and the prompt has no tools bound. The run is still a plain completion, as
  before — but the function you handed over is never called, and nothing used to say so.
- **Breaking.** `ToolDetail` gained five required fields (`callable`, `version_count`,
  `latest_version_number`, `executor_type`, `aliases`). It is a `@dataclass` with no
  defaults, so code that *constructs* one — a test fixture or a fake client — now raises
  `TypeError: __init__() missing 5 required positional arguments`. Code that only reads a
  `ToolDetail` returned by `tools.get()` / `tools.list()` is unaffected.

  **Migrating from 0.14**

  1. Grep for `ToolDetail(` in your own code. Only literal constructions need changing;
     there is no rename and no call-signature change.
  2. Supply the five fields, or build the object from a payload with
     `ToolDetail.from_dict(...)`, which fills them for you.

  Python catches this at run time, not at import time — a fixture that is only built
  inside one test path will not fail until that test runs.

### Fixed

- `gateway.chat(tools=[...])` now rejects a function decorated with `@acrux.tool` before
  sending anything, naming the tool and pointing at `run_tool_loop`. It used to die inside
  `json.dumps` as `Object of type function is not JSON serializable`.
- The no-tools-bound warning above could fire even when `tools` or `tool_defs` already gave
  the model something to call — it read only the prompt's own bindings. It now fires only
  when the run truly offers the model nothing.

## 0.14.0 — 2026-09-14

### Added

- `gateway=` on `gateway.chat()`, `gateway.stream()`, `gateway.run_tool_loop()` and
  `gateway.run_prompt_with_tools()` — the per-call gateway controls
  `{"max_retries": ..., "fallback": ...}`, which until now could only be sent by leaving
  the SDK and writing the HTTP request by hand.
- `GatewayControl` is exported for typing that dict. `maxRetries` is accepted as a key
  alongside `max_retries`, so a value copied from a curl example still works.
- `ToolResult.error(type, message, result=...)` and `ToolResult.warn(...)` — return one from
  a tool when only your code can tell a 200 response is really a failure. The span records
  it; the loop keeps going and the model still reads `result`.
- `type` lands on the span as `errorCode`, beside the closed-vocabulary `errorType`, so a
  failure mode you name yourself stays matchable. A warning's `type` is that slug too.
- Client-side tools are now checked against the catalog's `result_schema` when the resolved
  version declares one. A mismatch is a warning unless the version sets its severity to error.
- `error` and `warning` on `ToolExecuteResult`, carrying the platform's own classification
  of a server-side tool call.
- `result_schema` / `result_schema_severity` on `ResolvedTool`.

### Changed

- The client's own `max_retries` is documented as what it is: a retry of this SDK's request
  to AcruxCore. Use the per-call `gateway={"max_retries": n}` to change how many times a
  *provider* is called. Neither affects the other; nothing about the existing setting changed.
- A call made with the per-call `gateway=` controls now shows in its trace whether it was
  retried or served by a fallback model, and which model finally answered. The failing
  attempt's own provider message is recorded beside its status. No SDK change is needed.
- `tools.commit_version()` no longer documents `argMapping` or `bodyTemplate` on an `http`
  executor. Neither was ever applied, and the API rejects a commit carrying a non-empty one.
  Bind an argument with `{{arg.NAME}}` in a query value, a header value or the URL.

### Fixed

- Tool spans are no longer lost when a later round of `run_tool_loop` raises. They were only
  reported on the paths that remembered to flush, so a provider error mid-loop produced a
  trace showing a run that called no tools at all.

## 0.13.0 — 2026-09-13

There is no Python 0.12.0 — that number was a Node-only release. Both SDKs are
back in step at 0.13.0.

### Added

- `prompt_id` on `traces.list_traces()`. Matches traces using any version of a prompt,
  where `prompt_version_id` matches one exact version.
- `q_in` on `traces.list_traces()` — narrows `q` to `"input"`, `"output"` or `"name"`.
  `q` now also searches the captured request and response, not only names and attributes.
- `variables=` on `gateway.chat()`, `gateway.stream()` and `gateway.run_tool_loop()`.
  Sent as the gateway's top-level `variables`, and recorded on the `llm` span so feedback
  on the run can become an evaluation dataset example.
- `gateway.run_prompt_with_tools(rendered)` now forwards the render's variables for you,
  the same way it already derives the model, messages, tool refs and `prompt_version_id`.
- `RenderResult.variables` echoes what `prompts.render()` was called with, so a caller
  holding only the result can still pass the lineage on. Defaults to `{}`, so existing
  code that builds one by hand keeps working.
- `IngestSpan["variables"]` for a self-reported `llm` span. The API has always accepted
  it; the TypedDict never exposed it.

### Changed

- `variables` is a keyword-only argument in every position, added after
  `prompt_version_id`. No positional call sites move.

### Fixed

- A tool decorated with `@acrux.tool` and no docstring now reaches a BYO provider with the
  catalog's description. `run_tool_loop`/`run_prompt_with_tools` with `provider=` inlined
  the local schema, so the model saw the tool with no description at all and nothing said so.
- Only an undescribed tool costs the extra `POST /tools/resolve`; a documented one and the
  gateway path are unchanged, since the gateway already resolves `tool_refs` itself.
- A tool described neither in code nor in the catalog now warns on the BYO path, instead of
  being sent with nothing telling the model when to call it.


## 0.11.0 — 2026-09-06

### Added

- `FeedbackBucket.label` and `FeedbackBucket.prompt_id` on
  `traces.get_feedback_summary()`. `label` is the readable bucket name — the model, or
  `"<prompt name> v<n>"` for a prompt version; `prompt_id` is the owning prompt, `None`
  when grouped by model.
- `key` is unchanged and still the raw grouping value, so anything mapping a bucket
  back to a version id keeps working. Both new fields default, so positional
  construction of `FeedbackBucket` written against the old shape still works.
- `experiments.delete(experiment_id)` and `runs.delete(run_id)`. Deleting an experiment
  takes its runs with it; deleting a run leaves the experiment and any optimizer
  candidates it drafted.
- Both raise a 409 ``RUN_IN_FLIGHT`` error while a run is still queued or running — the
  worker is mid-flight, so finish first, then delete.
- `traces.ingest(input, wait=False)`: buffers the trace in the client's span queue — the
  same one the gateway reports through — and returns immediately, so instrumenting a
  retrieval or rerank step costs no round trip.
- The returned ``trace_id`` is generated client-side in that mode and is usable at once:
  the ingest endpoint creates the trace under it, so it can go straight into
  ``gateway.chat(trace={"traceId": trace_id})``.
- `traces.flush()`: waits for everything buffered (yours and the gateway's) to be sent.
  Call it before reading a trace back or before a short-lived process exits.

### Changed

- Nothing by default. ``wait`` defaults to ``True``, which is the existing behaviour: one
  awaited POST, errors raised at the call site, the server's trace id in the result. With
  ``wait=False`` a failed send warns once per error kind and drops the batch instead.

## 0.10.0 — 2026-08-21

### Added

- `prompts.list_aliases(prompt_id)`: the read half of `promote_alias`, answering "which
  version is `production` on right now?" without hand-building an HTTP call. Returns one
  `AliasDetail` per alias, or an empty list for a prompt with no committed version.
- `AcruxCore.aclose()`: flushes pending traces **and** closes the HTTP connection pool.
  Use it wherever `async with` is not available — a notebook cell, a REPL, or a server's
  own shutdown hook. `gateway.aclose()` still stops at the span queue.
- `client_tools` on `gateway.run_tool_loop` and `gateway.run_prompt_with_tools`: a
  `{tool_name: fn}` map that runs a catalog tool whose executor is `client`, without the
  hand-written `dispatch` router that was previously the only way.
- Unlike `tools=[fn]`, it writes nothing to the catalog: the tool's definition, its
  binding's alias or pin, and the `toolVersionId` stamped on the tool span all stay the
  catalog's.
- Each function is called with the tool schema's own field names as keywords, so
  `search_flights(origin=..., destination=...)`. A schema field that is a Python keyword,
  such as `from`, needs `**kwargs` instead.
- Two failures now raise before the first model call: `MISSING_DISPATCH` for a bound
  `client` tool with no runner (listing the `client_tools` keys supplied, so a mistyped
  key shows itself), and `VALIDATION_ERROR` when a function cannot receive the schema's
  required arguments.

### Changed

- An `http` tool named in `client_tools` is ignored in silence. The platform runs it, and
  one map is meant to serve prompt aliases whose executor differs — `production` on
  `http`, `staging` on `client`.
- `dispatch` is unchanged and not deprecated. It stays the right input for a tool set
  whose names are only known at runtime.

### Fixed

- `async with AcruxCore()` now closes the `httpx` client on exit. It flushed traces and
  stopped there, so a process building one client per request or per job leaked a
  connection pool each time — reported only as a `ResourceWarning`, which is off by default.
- `gateway.chat()` on the gateway path no longer reports an `llm` span of its own. The
  gateway already writes that span, so any `trace` value but `False` counted every model
  call twice — wrong span counts, wrong per-trace token totals, and nothing errored.
- `gateway.chat(trace={"name": ...})` now reaches the gateway. The key worked on
  `run_tool_loop` and was silently dropped here; `trace_id` and `session_id` in the same
  dict were dropped too, so a `chat()` could not join a trace at all. Streamed gateway
  calls sent none of these headers.
- A tool loop that joins an existing trace (`trace={"trace_id": ...}`) no longer renames it
  to `runToolLoop`. The default name is still sent for a trace the loop opens, and an
  explicit `name` still wins either way. The default now travels on the API's new
  `x-trace-name-if-unset` channel, so the server enforces this rather than trusting the
  client — see the gateway reference.
- An error raised for a BYO provider call now carries the provider's own reason. Both
  `gateway.chat` and its streaming path said only `provider returned 400 calling chat
  completions` while the cause sat unread on ``err.body``.

- A call with no model now fails in the SDK with ``VALIDATION_ERROR`` instead of being
  sent. A BYO provider reads an absent model as licence to pick its own default and then
  rejects it, so the raised error named a model the caller never wrote.
## 0.9.0 — 2026-08-20

### Added

- New `gateway.run_prompt_with_tools(rendered, **kwargs)`: takes a `render()` result
  and derives `model`, `messages`, `tool_refs` and `prompt_version_id` from it, so a
  call site no longer restates any of them. Any keyword passed wins over the derived
  value.
- **`stream=True` on `gateway.run_tool_loop` (and on `run_prompt_with_tools`)**
  returns an `AsyncToolLoopStream` of typed events — `content` / `tool_call` /
  `tool_result` / `done` — instead of awaiting the whole loop. The trace is identical
  to a non-streamed run: one `llm` span per round, with the round's tool spans under it.
- `tool_refs` entries (and `tools.resolve` refs) accept `version` to pin one exact
  tool build instead of following an alias. A binding pinned on the platform now
  travels as a pin through `run_prompt_with_tools`, rather than as its alias.
- New exported types `ToolLoopEvent`, `ToolLoopContentEvent`, `ToolLoopToolCallEvent`,
  `ToolLoopToolResultEvent`, `ToolLoopDoneEvent` and `AsyncToolLoopStream`.
- `prompts.render()` now also returns `tool_resolutions` — per-tool metadata (the
  alias or pin actually resolved, its version number, and which binding decided
  it) alongside the existing `tools` list.
- New `with_tool_override(rendered, name=..., alias=...)` helper: overrides one
  bound tool's alias for a single `gateway.chat()`/`gateway.run_tool_loop()`
  call. Handles the tools/tool_refs name-collision removal for you and warns
  (naming the prompt's current setting) when the tool was already bound, so
  the override doesn't read as the prompt's own configuration.
- Six new prompt→tool binding methods, replacing the removed `tool-routes`
  endpoints: `prompts.list_tool_bindings`, `set_tool_binding`,
  `remove_tool_binding`, `set_alias_tool_binding`, `remove_alias_tool_binding`,
  `reset_alias_tool_bindings`.
- `set_tool_binding()` writes the default every prompt alias inherits;
  `set_alias_tool_binding()` gives one alias its own binding, including
  `off=True` for "this alias deliberately has no such tool".
- New dataclasses `ToolBindingDetail`, `AliasToolBindings`, `PromptToolBindings`,
  and a `VALIDATION_ERROR` error code for a binding the SDK rejects before
  sending (no target, two targets, or `off=True` on the default).

### BREAKING

- **`commit_version()` no longer takes `tools=`.** A version decides the template
  only; tools are bound per prompt alias.
  1. *Migrating from 0.8:* delete the `tools=[...]` argument from every
     `prompts.commit_version(...)` call, and replace each entry with
     `await hub.prompts.set_tool_binding(prompt_id, tool_id, tool_alias=...)` (or
     `pinned_version_number=...`) — once per tool, not once per commit.
  2. The runtime catches this immediately and by name: the call raises `TypeError:
     PromptsNamespace.commit_version() got an unexpected keyword argument 'tools'`.
- **The `tool-routes` endpoints are gone** —
  `PUT`/`DELETE /prompts/:id/aliases/:alias/tool-routes/:toolId` and
  `/prompts/:id/tool-routes` return 404. The binding methods replace them.
  1. *Migrating from 0.8:* swap any raw request to
     `PUT /prompts/:id/aliases/:alias/tool-routes/:toolId` for
     `prompts.set_alias_tool_binding(prompt_id, alias, tool_id, tool_alias=...)`,
     and the matching `DELETE` for `prompts.remove_alias_tool_binding(...)`.
  2. Nothing catches this for you: no SDK method ever wrapped those paths, so
     grep your code for `tool-routes` — a stale caller fails at runtime with a 404.

### Changed

- **`tool_resolutions[].overridden` (bool) is now `source: "alias" | "default"`.**
  `"alias"` means the prompt alias had a binding of its own, `"default"` that it
  inherited the prompt's default.
  1. *Migrating from 0.8:* replace `r.overridden` with `r.source == "alias"`. The
     old `True` and the new `"alias"` do not mean the same thing — `True` used to
     mean "a live override outranked the version's attachment", a distinction the
     single binding table no longer has.
  2. The runtime catches this: `overridden` is gone from `ToolResolution`, so
     reading it raises `AttributeError` rather than quietly returning a falsy value.
- **`prompt_version_id` now actually reaches the gateway.** It used to be stamped
  only on client-written spans, so on the gateway path — where the gateway writes the
  `llm` span — passing it did nothing and the span had no link back to the prompt. It
  is sent as `prompt_version_id` on the request body now, and never to a BYO provider.
  Needs an API deployed on 2026-08-20 or later; an older one ignores the field,
  exactly as before.
- `with_tool_override`'s warning now names which binding holds the current setting
  ("the prompt's default binding" / "this prompt alias's own binding") instead of
  saying "via a routing override". Same helper, same name, same behaviour.

## 0.8.0 — 2026-08-11

### Added

- `acruxcore.otel` — `register()` builds a `TracerProvider` + `BatchSpanProcessor` +
  `OTLPSpanExporter` pointed at AcruxCore's OTLP endpoint in one call, and can
  auto-instrument a named framework (`crewai`, `openai`, `openai_agents`,
  `langchain`, `llama_index`) via `instrument=[...]`. Requires the new `otel`
  extra: `pip install acruxcore[otel]`. See the [OTel helper
  guide](https://docs.acruxcore.com/docs/guides/send-otel-traces-with-the-sdk-helper).

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
