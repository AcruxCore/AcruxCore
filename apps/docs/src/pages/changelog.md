---
title: Changelog
description: What shipped in AcruxCore each week — new endpoints, SDK releases, dashboard changes, fixes, and new guides.
hide_table_of_contents: false
---

# Changelog

What shipped, a week at a time. AcruxCore deploys continuously, so these are weekly
summaries rather than numbered releases — the SDKs are the exception and follow semver.

Each **major** change gets its own heading and up to three bullets, one line each. **Minor**
changes are a single line, no heading.

The two SDKs keep their own release notes, including migration steps for breaking changes:
`@acruxcoreai/sdk` on [npm](https://www.npmjs.com/package/@acruxcoreai/sdk) and
`acruxcore` on [PyPI](https://pypi.org/project/acruxcore/).

:::note[Beta]
AcruxCore is in beta and pre-1.0. Breaking changes still happen; when one does, it is
called out in the week it ships and in the SDK release notes.
:::

---

## Week of 14 September 2026

### Major

#### `gateway.fallback: false` keeps a call on the model you asked for

- The key was accepted and read by nothing, so a `false` still returned a different model's answer.
- It now returns the model's own failure instead, on streaming and non-streaming calls alike.
- Retries are untouched: a retry is the same model, so `false` still allows them.
  [Reference →](/api-reference/gateway/)

#### Both SDKs can set the gateway's per-call retry and fallback controls

- New `gateway` argument on `chat`, `stream`, `runToolLoop` and `runPromptWithTools` in both languages.
- The client's own `maxRetries` retries the SDK's own request and never reached a provider.
- Setting it no longer means leaving the SDK and writing the HTTP request by hand.
  [Reference →](/docs/sdk-reference/python)

#### A trace now says whether a call was retried or fell back, and to which model

- The span panel now states it in words: "retried 3 times, then fell back to mistral-small".
- One row per model tried shows its registered name, provider, calls, and how its turn ended.
- Each attempt now records the provider's own error message, not only its HTTP status code.

#### A call that only succeeded because of a retry or fallback is flagged, not plain green

- A primary model failing every request was invisible while its fallback kept answering.
- These runs stay `ok` rather than errors — the trace list now marks them amber.
- The existing `warning:yes` filter finds them, so you can count them across a week.
  [Reference →](/api-reference/traces/)

#### Both SDKs released as 0.14.0

- `@acruxcoreai/sdk` 0.14.0 on npm and `acruxcore` 0.14.0 on PyPI, from one set of changes.
- Ships the per-call `gateway` controls and the client-side tool error and warning helpers.
  [Reference →](/docs/sdk-reference/node)

#### Both SDKs released as 0.15.0

- `@acruxcoreai/sdk` 0.15.0 on npm and `acruxcore` 0.15.0 on PyPI.
- `ToolDetail` now reads the catalog's readiness fields, so `tool.callable` works in both.
- Breaking for code that *builds* a `ToolDetail`; the release notes carry the migration.
  [Reference →](/docs/sdk-reference/node)

#### The tool catalog says whether each tool can actually be called

- Every row shows its version count, where `production` points, and who runs the call.
- A tool with no version is flagged **No version yet** instead of looking the same as a working one.
- The prompt's tool picker disables those tools instead of offering a binding to nothing.
  [Reference →](/api-reference/tools/)

#### Creating a tool is one step instead of two

- **New tool** asks for the name, description, parameters and executor in one dialog.
- One click writes the tool and version 1 together, so you cannot leave a dead name behind.
- The API is unchanged — `POST /tools` then `POST /tools/:id/versions`.

#### A version committed in the dashboard no longer drops its failure checks

- Every dashboard commit discarded `failureWhen`, `resultSchema` and its severity.
- Both fields are now editable, and the section opens itself when a version carries them.
- Recheck any HTTP tool re-committed from the dashboard since 7 September.
  [Reference →](/api-reference/tools/versions)

#### The tool catalog and its pickers were missing tools past the first page

- **Fixed** — the catalog and tool pickers listed only the first 20 tools; the rest read as deleted.

#### Prompt pickers were missing anything past the first page

- **Fixed** — the Playground, Save Version and evaluation pickers listed only the first 20 prompts.
- **Fixed** — a trace filter's saved prompt chip showed a raw id instead of a name past that page.

#### A prompt past 100 commits lost its oldest versions

- **Fixed** — the promote control, the Diff tab and the Versions tab could not see or restore them.

### Minor

- The [Retries and Fallbacks guide](/docs/guides/automatic-model-fallbacks) now shows a retried trace and a fallback trace side by side.
- The same guide covers registering a model with its first fallback, not only editing one.
- The same guide now shows Python and Node SDK code beside every curl example.
- The gateway API reference documents both keys of the `gateway` control object.
- Tools moved into the sidebar's Workspace section, under Prompts; old links redirect.
- Versions and aliases are one tab now — each version row shows the aliases pointing at it.
- Renaming a tool, editing its catalog description and deleting it moved into a **Settings** dialog.
- The prompt's Tools tab has a searchable picker, and each tool name links to its catalog page.
- Both SDKs warn when you pass tool implementations to a prompt that has no tools bound.
- The tool pages now share one routing table in [Core concepts](/docs/getting-started/core-concepts).
- **Fixed** — an unreachable executor URL now names the host and says which field it came from.
- **Fixed** — deleting a tool no longer leaves the page refetching endpoints that just became 404.
- **Fixed** — a blank or zero tool alias version was accepted; it pointed at no real version.
- Both SDK references open with a table saying which call runs your tools, and what to pass it.
- The same table is in [Core concepts](/docs/getting-started/core-concepts), with where each tool runs.
- Self-hosters can set `WEB_HOST` to reach a development dashboard from another machine.
- **Fixed** — `chat()` now names the call that runs a tool when handed a declared one, not a 400.
- **Fixed** — seven Node snippets in the tool tutorials were missing `new` and failed on paste.
- The prompt-tools guide now shows `run_prompt_with_tools` as a wrapper over `run_tool_loop`.
- **Fixed** — a guide and its two scripts omitted `variables` from the hand-written tool loop.
- The prompt-tools guide now covers the three SDK calls only, matching its title.
- The tool guides are one **Tools** section in the sidebar, in the order you would read them.
- Seven tool guides became five; every retired URL redirects to the page that replaced it.
- [Create a tool](/docs/guides/create-a-tool) is the one page for both ways to define one.
- Every guide now sits in one of six sections: Prompts, Gateway, Traces, Tools, Evaluation, Team.
- Guide URLs are unchanged, and each section has its own index, such as [Traces](/docs/guides/traces).
- [Create a tool](/docs/guides/create-a-tool) now shows Python and Node SDK code beside every curl example.
- [Evaluate a prompt](/docs/guides/evaluate-a-prompt) now shows SDK code for reporting feedback, not only curl.
- **Fixed** — the SDK chat guide left `trace_id` out of the gateway metadata it documents.

---

## Week of 7 September 2026

### Major

#### A failed tool call is no longer a green span

- A tool whose upstream answers 4xx or 5xx now records an **error** span; the trace turns red too.
- The call still returns the body to your agent — detecting the failure does not change control flow.
- New `error_type:` and `warning:` filters say *which kind* of failure, not just that one happened.
  [Reference →](/api-reference/traces/)

#### Count the failure mode your own tool named

- `error_code:<your slug>` matches one declared failure exactly; a text search also finds mentions.
- The filter box suggests the slugs your tools have declared, and `GET /traces/facets` returns them.
  [Reference →](/api-reference/traces/)

#### A model round that fails now appears in the trace

- A completion that fails after every retry and fallback writes a red `llm` span instead of nothing.
- Retry and fallback history is on the span, so a call that only succeeded on its third attempt shows it.
- A failed middle round lands in the same trace as the rounds around it, not a separate one.

#### Tools can declare their own failures and warnings

- Return `ToolResult.error(...)` / `toolError(...)` when a 200 response is really a failure.
- An HTTP tool can declare `failureWhen` (a predicate on the raw response) and a `resultSchema`.
- A schema mismatch is a warning by default; set `resultSchemaSeverity: "error"` to make it fatal.
  [Reference →](/api-reference/tools/versions)

#### An HTTP tool's `argMapping` is rejected instead of ignored

- Neither `argMapping` nor `bodyTemplate` was ever applied, so a tool using one sent no argument.
- Bind an argument with `{{arg.NAME}}` in a query value, a header value or the URL instead.
- An empty list or string still commits, so every tool version already stored keeps working.
  [Reference →](/api-reference/tools/versions)

#### The whole team's audit trail, in the dashboard

- **Team → Audit trail** lists every recorded action — keys, members, gateway, secrets, prompts, tools.
- Filter by area, by a single event, and by who did it; the filters are in the URL, so a view is shareable.
- Owner and admin only; a Bearer key cannot read it, because the trail records what people did.
  [Reference →](/api-reference/audit)

#### One filter bar, on every screen that picks traffic

- Type `tag:`, `prompt:`, `input:`, `meta.<key>:` and the rest into a single box; each becomes a chip.
- The same bar is on Traces, Feedback, and a dataset's **Add example → From feedback**.
- Suggestions come from your team's own tags, metadata keys and prompt names.
  [Reference →](/api-reference/traces/)

#### Saved views

- Name a filter set and it is one click for the whole team, on Traces or Feedback.
- Any member can rename or delete a view; the filters are stored exactly as you set them.
  [Reference →](/api-reference/traces/views)

#### Add every row a filter selects, not just the page

- **Add all N matching** in **From feedback** builds from criteria instead of ticked boxes.
- It reaches rows on pages you never opened, and says when more matched than one request takes.
  [Reference →](/api-reference/datasets)

#### Find a trace by what was actually said

- `q` now searches the captured request and response, not only names and attributes.
- `q_in` narrows a search to `input`, `output` or `name` when a word appears on both sides.
- Payload text is searchable wherever payload capture was on for the trace.
  [Reference →](/api-reference/traces/)

#### Filter by prompt, and filter the feedback feed

- `prompt_id` matches every version of a prompt, so you no longer need the version id.
- The feedback feed takes the full trace filter set plus `rating`, `source`, `label`, `has_comment`.
- One filter vocabulary now covers traces, feedback and dataset building.
  [Reference →](/api-reference/traces/feedback)

#### Build a dataset from criteria instead of a hand-picked list

- Both `from-feedback` endpoints accept a `filter` in place of `feedback_ids`.
- "Every thumbs-down with a comment on the checkout prompt" is one request.
- The response reports `matched`, so a selection capped at 100 rows is visible.
  [Reference →](/api-reference/datasets)

#### Curate a dataset after you build it

- **Add example** now has a **From feedback** tab — pull real rows into a dataset that already exists.
- A row brings its captured variables, its comment as criteria, and its session history.
- A row already in the dataset is reported as skipped, never added twice.
  [Reference →](/api-reference/datasets)

#### Edit criteria, drop a row, delete a dataset

- The criteria cell edits in place, so a rubric inherited from a complaint can be reworded.
- Every example row has a remove control, and a dataset can be deleted from either screen.
- Both ask for confirmation first; past experiment runs keep their reports either way.

#### A tool's dashboard description now reaches your own provider

- A tool defined in code with no docstring now takes its description from the catalog.
- A bring-your-own-key run used to send that tool with no description at all.
- A tool described in neither place now warns instead of going out silently.
  [Guide →](/docs/guides/create-a-tool)

#### Both SDKs released as 0.13.0

- `npm i @acruxcoreai/sdk@0.13.0` and `pip install -U acruxcore` carry everything above.
- `variables`, `prompt_id` and `q_in` are in both, as is the tool-description fix above.
- Node only: `RenderResult` now requires `variables`; the migration step is in its notes.

#### Choose the model and the instructions that optimize a prompt

- **Optimizer model** picks which model writes the rewrites, not just what they run on.
- **Optimizer prompt** swaps the built-in instructions for your own, format still enforced.
- An unregistered optimizer model is now rejected up front instead of failing mid-run.
  [Reference →](/api-reference/optimize)

#### Trace a LangChain or LangGraph agent, in Python or Node

- New tutorial builds a two-tool research agent in both languages, traced end to end over OTLP.
  [Tutorial →](/docs/tutorials/trace-a-langchain-research-agent)
- One instrumentor covers chain, tool and LLM spans; adding `openai` double-counts every call.
- `instrument: ['langchain']` ships in Node SDK 0.12.0; Python has had it since 0.11.0.

#### Evaluate a run your own app rendered

- Send `variables` beside `prompt_version_id` and they are stored on the span, not discarded.
- A stored prompt with no placeholders can now produce dataset examples from real traffic.
- Those messages are never re-rendered — you rendered them, so the values are lineage only.
  [Reference →](/api-reference/gateway#send-variables-with-it)

#### Team API keys now appear in the audit trail

- **Fixed** — minting or revoking a team-scoped key wrote no audit event, so the trail missed it.
- Both events now name the member who acted and mark the key as team-scoped.
  [Reference →](/api-reference/audit)

### Minor

- A new guide shows how a tool reports a failure its HTTP status cannot: [Report a tool failure](/docs/guides/report-a-tool-failure-from-your-own-code).
- The fallback guide now covers retries too, and which of the three retry settings does what.
  [Guide →](/docs/guides/automatic-model-fallbacks)
- The API reference documents the completion body's `gateway` control field and its `maxRetries`.
  [Reference →](/api-reference/gateway/)
- **Fixed** — the SDK tool-lifecycle guide bound its argument in a form the executor never read.
- The filter bar takes two filters at once — `rating:down comment:yes` commits both chips.
- **Fixed** — a value the filter bar rejects now stays in the box and says what that filter takes.
- **Fixed** — failure filters set in the dataset dialog are applied now, not silently dropped.
- **Fixed** — the Python tool-calling tutorial's first option produced traces with no prompt version.
- The tagging and filtering guide now covers typing several filters in one go.
  [Guide →](/docs/guides/tag-and-filter-traces)
- The team audit endpoint takes `event` (a comma-separated list) and `actorId`; both narrow `total`.
- A new `/teams/:id/audit/actors` lists everyone in the trail, removed members included.
- A member role change or removal now reports the affected member's address, not just their id.
- The Team page previews the five newest recorded actions, with a link to the full trail.
- A sixth feature page, **Audit**, covers what the trail records, the filters, and the roles.
- New guide walks the trail from the Team page to a filtered URL you can paste into a ticket.
  [Guide →](/docs/guides/read-the-team-audit-trail)
- Core concepts names the split: a trace is traffic your app made, an audit event is a change.
- The home page's round-trip now opens on the trace and closes on the audit trail.
- The compare page's audit-log and RBAC rows now link the guides behind them.
- **Fixed** — the compare page and the comparison post said five competitors; there are six.
- The nine-platform comparison gains an audit-trail row, and says which two we never checked.
- The docs home and the project README now name **Audit** among the building blocks.
- The best-open-source-LLMOps page marks best-for, limitations and licence with a coloured icon.
- The comparison matrix marks each verdict with a glyph and shades the AcruxCore column.
- The FAQ's comparison answer now names the audit trail as the row no paid plan gates.
- **Fixed** — the FAQ said the comparison matrix weighs nine criteria; it weighs ten.
- The security page covers roles and the trail: what it records, and what it keeps out.
- The roles guide says role changes are recorded, and which roles can read the trail.
- Dataset examples show a **Prompt** column naming the prompt version the row was captured from.
- A dataset row with no variables now shows the prompt's own last message instead of a dash.
- Long variable values in a dataset row clip to one line each, with **Show all** to read them.
- Feedback rows now name the team member who posted them, not just "Developer".
- **Fixed** — feedback skipped when building a dataset blamed payload capture even when it was on.
- **Fixed** — the real reason is now named: a call that sent raw messages has no variables to replay.
- Row delete and edit controls use proper icons and stay visible, instead of a hover-only ✕.
- The dataset page's Optimize button and dialog now say they optimize a prompt, not the dataset.
- **Fixed** — deleting a dataset logged a 404 in the browser console on the way out.
- **Fixed** — optimize used a fixed model name a team may never have registered.
- The model picker scrolls past seven models and shows a selected count, instead of growing.
- The models field now says one set of rewrites is tested on every model picked, not one each.
- **Fixed** — a dialog taller than the window put its own buttons out of reach; it scrolls now.
- **Fixed** — two appends of the same feedback row at once could file it into a dataset twice.
- Feature pages now explain fallbacks, OTel ingestion, bindings and the optimizer.
- **Fixed** — the evaluation page's curl sample dropped every id from its URLs.
- **Fixed** — that sample passed `version_ids: ["v7","v8"]`; the API takes version UUIDs.
- **Fixed** — a docstring-less tool wrongly warned a deploy would undo its dashboard wording.
- Tracing is no longer gateway-only on the page; the OpenTelemetry path is named.
- The docs site now publishes `/llms.txt`, a summary index of every page for AI crawlers.
- A new [FAQ page](https://acruxcore.com/faq) answers how AcruxCore compares, and where it does not fit.
- A new [best open-source LLMOps platforms](https://acruxcore.com/best-open-source-llmops-platforms) page compares seven.
- Each entry says what that platform is best for, where it falls short, and when it was checked.
- The main site now publishes `/llms.txt` too, and both sites name the AI crawlers they allow.
- The home page gained an at-a-glance block: category, licence, deployment, SDKs, price, audit trail.
- Both `/llms.txt` files and the home page's structured data now state what the audit trail records.
- The FAQ answers which platforms log who changed what, and what an audit log costs.
- A new FAQ answer separates a trace from an audit event: traffic sent versus a change made.
- The category page's seventh question asks who changed what, and whether it needs a paid plan.
- The API reference now documents the team-wide audit trail, for owners and admins.
  [Reference →](/api-reference/audit)
- The gateway page names the native providers and the compatible connections.
- Each feature page carries a real product screenshot and a first action of its own.
- The homepage names the step it was missing: score a fix before promoting it.
- The homepage lists evaluation and spend guardrails among the reasons to switch.
- **Fixed** — sitemap `lastmod` dates trailed one commit behind the content they describe.
- Sitemap dates now track every file a page renders, not only its own component.
- **Fixed** — the "no eligible rows" error now names each real reason and how many rows hit it.
- A skipped feedback row now says what is missing in a few words, and never points at a setting.
- A tag or model shown on a span is now a link that opens the trace list filtered to it.
- Filtering a list resets the page and clears any selection, instead of leaving both stale.
- **Fixed** — a span's input and output showed as one long escaped line; nested JSON is decoded now.
- **Fixed** — "Expand" on a payload removed the height cap and pushed the page away; it scrolls now.
- **Fixed** — long attribute and metadata values were cut off with nothing to click; they expand now.
- **Fixed** — a run cell's output was shown as quoted, escaped text instead of what the model wrote.
- The dataset examples table says what a row is in a plain line above the table.
- Both tutorial scripts and a runnable Python notebook ship with the output of a real run.
- The notebook demonstrates a failing tool: the agent answers confidently, and gets it wrong.
- **Fixed** — the `traces.ingest()` link in both SDK references jumped nowhere.
- New landing-page overview video: one prompt from versioned template to promoted fix.
- **Fixed** — a week in this changelog showed a duplicated entry and a stray heading.
- The compare page, the README and the nine-platform post gain a prompt-optimizer row.
- **Fixed** — the comparison post said no competitor automates a prompt rewrite; two do.
- Each feature page now names its capability in the title, the heading and the page summary.
- The six feature pages link each other by capability, not by a one-word label.
- **Fixed** — search previews cut every marketing page's description off halfway through.
- The best-open-source-LLMOps page answers the audit question in shorter, plainer sentences.
- The FAQ and the open-source LLMOps comparison page are rewritten in shorter, plainer sentences.
- The comparison matrix reads as plain sentences, and every licence row is worded the same way.

---

## Week of 31 August 2026

### Major

#### Upstream rate limits answer 429 with the provider's own reason

- Provider 429s now answer `429 PROVIDER_RATE_LIMITED`, not an opaque `502 PROVIDER_ERROR`.
- The provider's own reason and its `Retry-After` come through, so quota and pace differ.
  [Reference →](/api-reference/gateway#upstream-rate-limits)
- Streaming requests answer the same way, as JSON, before any bytes are written.

#### Start a dataset from the dashboard, without waiting for feedback

- **New dataset** on Evaluations → Datasets creates an empty dataset — no traffic needed.
- **Add example** writes one row by hand: named variable fields, or raw JSON for other types.
  [Guide →](/docs/guides/evaluate-a-prompt)

#### Evaluation runs and experiments can be deleted

- `DELETE /api/v1/runs/:id` removes a run and its cells; the Runs tab has a Delete action.
- `DELETE /api/v1/experiments/:id` removes an experiment and every run under it.
  [Reference →](/api-reference/experiments)
- Both answer `409 RUN_IN_FLIGHT` while a run is still queued or running.

#### Report your own spans without waiting for the network

- `traces.ingest(..., wait=false)` buffers the trace and returns a usable trace id at once.
- Measured at the call site: 6.5ms awaited, 0.017ms buffered, on a local API.
  [Node](/docs/sdk-reference/node) · [Python](/docs/sdk-reference/python)
- New `traces.flush()` drains the buffer; both SDKs, both unchanged by default.

### Minor

- **Fixed** — the feedback summary grouped by prompt version showed a raw id, not a name.
- Feedback summary buckets now carry `label` and `promptId` alongside the unchanged `key`.
  [Reference →](/api-reference/traces/feedback)
- Sessions can be searched by id from the page itself, not only by editing the URL.
- **Fixed** — the Evaluations → Runs tab was headed "Datasets" and described the wrong page.
- **Fixed** — a custom provider base URL dropped every upstream response header.

---

## Week of 17 August 2026

### Major

#### Traces are named by what ran, not by a timestamp

- Traces sent over OTLP now take their root span's name instead of the time they started.
- A trailing run id is trimmed, so two runs of the same crew share one searchable name.
- A tool loop that joins an existing trace no longer renames it to `runToolLoop`.
  [Guide →](/docs/guides/using-sessions-and-traces)

#### Name a trace as a fallback, without overwriting a name it already has

- New `x-trace-name-if-unset` header (and body `trace.nameIfUnset`) on gateway completions.
- It names a new trace, and is ignored on one that already has a real name.
- `x-trace-name` is unchanged: still an instruction, still overwrites.
  [Reference →](/api-reference/gateway)

#### A `chat()` call with a trace option no longer counts itself twice

- **Fixed** — passing `trace` to `gateway.chat()` reported a second `llm` span per call.
- Span counts, per-trace token totals and per-run call counts were all wrong, silently.
- `trace` now also carries the name, trace id and session id through `chat()`, as on the loop.
  [Reference →](/api-reference/gateway)

#### A provider's 400 now names the rule you broke

- The gateway forwards the provider's own message for a 400, 404, 413 or 422.
- A strict-mode `response_format` error names the exact property, not just "status 400".
- 401, 403, 429 and every 5xx stay summarised — those describe the connection, not your request.
  [Reference →](/api-reference/gateway)

#### OpenAI's cached prompt tokens are now billed at the cached rate

- A repeated prompt prefix that OpenAI serves from cache is charged at half the input rate.
- `usage.cached_tokens` is returned on the gateway response, as a subset of `prompt_tokens`.
- Costs in traces, budgets and usage were overstated for any repeated system prompt.

#### Both SDKs released as 0.10.0

- `npm i @acruxcoreai/sdk@0.10.0` and `pip install -U acruxcore` carry `client_tools`.
- New `prompts.list_aliases()` / `listAliases()` reads which version an alias points at.
- Python `async with AcruxCore()` now closes its HTTP connection pool on the way out.
  [Guide →](/docs/guides/call-a-prompts-tools-from-the-sdk)

#### Run a prompt's client tools without writing a dispatcher

- Both SDKs take `client_tools` / `clientTools`: tool name to the function that runs it.
- Nothing is written to the catalog, so the tool's definition and its binding's pin stay put.
- A missing implementation stops the run before the first model call, naming the tool.
  [Guide →](/docs/guides/call-a-prompts-tools-from-the-sdk)

#### Connect a tool to a prompt by choosing its alias

- Bind a catalog tool to a prompt in one write — no version to commit, no alias to promote.
- Give one prompt alias its own tools: a different build of one, or none at all.
- Breaking: `POST /prompts/:id/versions` no longer accepts `tools` — bind the tool instead.
  [Guide →](/docs/guides/connect-a-tool-to-a-prompt)

#### See what a render will really call

- `render()` returns `toolResolutions`: the tool alias followed, its version, and the binding.
- `source` reads `alias` when the prompt alias has its own binding, `default` when inherited.
  [Reference →](/api-reference/prompts/tool-bindings)

#### See when a tool's code changed

- New `GET /api/v1/tools/:id/audit` trail: version commits, code-sync pushes, and binding changes.
  [Reference →](/api-reference/audit)

#### Evaluation rules: real models, real filters, custom judge prompts

- Judge model is now a required dropdown — no more silent fallback to an unregistered model.
- Match filter's model, prompt+alias, and tags fields are now dropdowns, not free text.
- Use one of your own Prompts as the judge's grading template instead of the built-in one.
  [Guide →](/docs/guides/score-live-traffic-with-an-evaluation-rule)

#### Run a prompt's tools in two lines

- `gateway.runPromptWithTools(rendered)` takes a render result and fills in the rest.
- Model, messages, bound tools and prompt lineage all come from the render, not the call site.
- A binding pinned to an exact tool version now travels as a pin, not as its alias.
  [Guide →](/docs/guides/call-a-prompts-tools-from-the-sdk)

#### A tool-using agent can stream its answer

- `stream: true` on the tool loop yields typed events: `content`, `tool_call`, `tool_result`, `done`.
- Same trace as an unstreamed run — one `llm` span per round, tool spans nested under it.
- Both SDKs, and on `runPromptWithTools` too.
  [Guide →](/docs/guides/call-a-prompts-tools-from-the-sdk)

#### Client-side tool loops keep their prompt lineage

- **Fixed** — SDK loops produced `llm` spans with no link back to the prompt version.
- `POST /gateway/chat/completions` now accepts `prompt_version_id` next to your own `messages`.
- Both SDKs send it automatically; a version from another team is rejected, not stamped.
  [Reference →](/api-reference/gateway)

#### Both SDKs released as 0.9.0

- `npm i @acruxcoreai/sdk@0.9.0` and `pip install -U acruxcore` carry everything above.
- Breaking: committing a version no longer takes `tools` — bind the tool to the prompt.
- Breaking: the `tool-routes` endpoints are gone; the binding methods replace them.
  [Guide →](/docs/guides/call-a-prompts-tools-from-the-sdk)

### Minor

- `tool_refs` and `POST /tools/resolve` now take `version` to pin one exact tool build.
- **Fixed** — an undecryptable provider credential now returns a clear 409, not an opaque 500.
- **Fixed** — `group_by=day` trace analytics bucketed days in the server timezone, not UTC.
- **Fixed** — the changelog showed one week as two sections, dated three days apart.
- `GET /traces/facets` now also returns distinct resolved models, for filter pickers.
- **Corrected** — comparison posts now reflect AcruxCore's rule-based online evaluation. [Reference →](/blog/acruxcore-vs-opik)
- New tutorial: a travel planner that picks between three tools, or calls none at all.
  [Tutorial →](/docs/tutorials/build-a-travel-planner-agent)
- Nine screenshots across the tutorials and guides now show the current alias-keyed Tools tab.
- **Fixed** — Python tabs in five tutorials called Node method names and Node argument shapes.
- **Fixed** — the Python/Node tabs for scripting gateway setup called two methods no SDK has.
- **Fixed** — the API reference's `datasets.createFromFeedback` example named a method that does not exist.
- **Fixed** — the trace-tagging guide still used the flat `get_trace()`/`getTrace()` removed in SDK 0.7.0.
- Four tutorials now ship a runnable `setup_prompt.py` for the prompt-and-tool setup step.
- **Fixed** — a malformed JSON body now returns 400 `INVALID_JSON`, not 500, so clients stop retrying it.
- **Fixed** — an oversized body returns 413 and an unsupported `Content-Encoding` returns 415.
- The travel-planner tutorial now shows every setup step twice: the dashboard click-through and the code.
- Tool parameters: a checkbox now writes `additionalProperties: false`, no raw JSON needed.
- **Fixed** — "Back to builder" on a tool version no longer looks dead; it greys out with a reason.
- New guide: where a tool's definition should live, and what changes in traces and deploys.
  [Guide →](/docs/guides/create-a-tool)
- That guide also ships as a runnable notebook, with a preflight check for a brand new account.
  [Guide →](/docs/guides/create-a-tool)
- The travel-planner tutorial now ships as a runnable notebook too, written for a first-timer.
  [Tutorial →](/docs/tutorials/build-a-travel-planner-agent)
- The Python SDK tool-calling tutorial ships as a runnable notebook, with both setup routes shown.
  [Tutorial →](/docs/tutorials/build-a-tool-calling-agent-in-python-sdk)
- **Fixed** — the New tool dialog implied its description always reaches the model.
- Resolving a tool now says it has no committed version, instead of answering a bare 404.
  [Reference →](/api-reference/tools/resolve)
- SDK errors now carry the API's own message, so the reason is in the exception you catch.
- **Fixed** — three tutorials no longer install `langchain-community`, which is being sunset.
  [Tutorial →](/docs/tutorials/build-a-react-agent)
- The Tavily tutorials now use Tavily's own `tavily-python` SDK instead of a LangChain wrapper.
  [Tutorial →](/docs/tutorials/build-a-configurable-react-agent)
- The no-SDK REST tutorial ships as a runnable notebook, including what unthreaded traces look like.
  [Tutorial →](/docs/tutorials/build-a-tool-calling-agent-in-python-no-sdk)
- The ReAct agent tutorial ships as a runnable notebook, covering who records a span on the BYO path.
  [Tutorial →](/docs/tutorials/build-a-react-agent)
- The configurable-agent tutorial ships as a runnable notebook, swapping model and persona by alias.
  [Tutorial →](/docs/tutorials/build-a-configurable-react-agent)
- The medical-information tutorial ships as a runnable notebook, with a citation check on every answer.
  [Tutorial →](/docs/tutorials/build-a-medical-information-qa-agent)
- The supervisor multi-agent tutorial now ships as a runnable notebook, routing traps included.
  [Tutorial →](/docs/tutorials/build-a-supervisor-multi-agent-system)
- The BYO-provider RAG tutorial now ships as a runnable notebook, with a live provider check.
  [Tutorial →](/docs/tutorials/build-a-rag-agent-without-the-gateway)
- The CrewAI tracing tutorial now ships as a runnable notebook, with four OTLP wiring traps.
  [Tutorial →](/docs/tutorials/trace-a-crewai-trip-planner)
- **Fixed** — the CrewAI tutorial's install command was missing the `tavily-python` client.
- The OpenAI Agents SDK tutorial now ships as a runnable notebook, handoff span included.
  [Tutorial →](/docs/tutorials/trace-an-openai-agents-sdk-triage-system)
- **Fixed** — a CrewAI trace is now named `Crew.kickoff`, not once per run id, so names group.
  [Tutorial →](/docs/tutorials/trace-a-crewai-trip-planner)
- **Fixed** — an SDK error from your own provider now names the reason, not just the status.
- **Fixed** — the SDK now says a model is required, rather than letting your provider guess one.
- **Fixed** — screenshots in every runnable notebook now load in GitHub, nbviewer and Jupyter.
- Runnable notebooks no longer repeat the API-key dialog screenshot; the menu path is enough.
- The tutorials now run on five models across OpenAI, Anthropic, Gemini, Llama and Mistral.
  [Tutorial →](/docs/tutorials/build-a-tool-calling-agent-in-python-sdk)
- **Fixed** — the ReAct agent tutorial said an OpenRouter key would not work; any provider does.
  [Tutorial →](/docs/tutorials/build-a-react-agent)
- **Fixed** — the travel-planner notebook crashed on a model registered without prices.

---

## Week of 10 August 2026

### Major

#### Score live traffic automatically with evaluation rules

- Create a standing rule that judges matching production calls with no run and no click.
- Filter by prompt, model, or tag; sample and cap spend; get alerted below a threshold.
  [Guide →](/docs/guides/score-live-traffic-with-an-evaluation-rule)

#### OTLP trace ingestion

- New `POST /api/v1/traces/otlp` accepts real OpenTelemetry exports over OTLP/HTTP
- Works with CrewAI, LangChain, LlamaIndex via `openinference-instrumentation-*` — no code change
- [Reference →](/api-reference/traces/otlp)

#### SDK 0.8.0 (Python) — `acruxcore.otel` helper

- `acruxcore.otel.register()` wires the OTLP pipeline in one call, with `instrument=[...]` for CrewAI, LangChain, LlamaIndex, OpenAI, and the OpenAI Agents SDK
- New optional extra: `pip install 'acruxcore[otel]'`
- [Guide →](/docs/guides/send-otel-traces-with-the-sdk-helper)

#### SDK 0.8.0 (Node) — `@acruxcoreai/sdk/otel` helper

- New subpath export wires the OTLP pipeline in one call, with `instrument: [...]` for OpenAI and the OpenAI Agents SDK
- `@opentelemetry/*` packages are new optional peer dependencies
- [Guide →](/docs/guides/send-otel-traces-with-the-sdk-helper)

### Minor

- **Fixed** — OTLP exports with input/output data could fail on retry instead of succeeding.
- **Fixed** — LLM cost showed blank for provider-dated model ids (e.g. `gpt-4o-mini-2024-07-18`).
- New tutorials: trace a [CrewAI crew](/docs/tutorials/trace-a-crewai-trip-planner) and an [OpenAI Agents SDK](/docs/tutorials/trace-an-openai-agents-sdk-triage-system) app over OTLP.
- **Blog tag and author pages** (`/blog/tags`, `/blog/authors`, and their archives) are now marked `noindex` so they stop competing with the posts they link to in search results.
- **Corrected** — comparison posts now state the gateway's spend caps and rate limits correctly. [Reference →](/blog/acruxcore-vs-mlflow)
- **Compare** — a row where a competitor lands in the same place as AcruxCore is now marked "Tie". [Reference →](https://acruxcore.com/compare)
- **Compare** — the Tool catalog row now records our edge over MLflow's MCP server registry.
- **Fixed** — the comparison table cut off its last column on wide screens, at any zoom level.
- **Repo README** now opens with a 35-second demo: prompt, version, tool, a real model call, the trace.

## Week of 3 August 2026

### Major

#### SDK trace analytics and sessions bindings

- New `hub.traces` namespace: analytics, facet discovery, and payload-capture settings.
- New `hub.sessions` namespace lists sessions and reads one session's full trace history.
- Feedback summary and the team-wide feedback feed are now reachable via `hub.traces` too.

#### SDK 0.6.7 — trace tags and metadata

- `chat()` and the tool loop now accept `tags`/`metadata` in trace options, sent as gateway headers.
- Both SDK packages now link back to the public [GitHub repo](https://github.com/AcruxCore/AcruxCore).

#### AcruxCore is now open source

- Source is public at [github.com/AcruxCore/AcruxCore](https://github.com/AcruxCore/AcruxCore).
- Licensed under [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license); `packages/sdk` and `packages/sdk-python` stay MIT.
- Contributions welcome — see `CLA.md` in the repo before opening a pull request.

#### Past evaluation runs are now listed in one place

- A new **Runs** tab on Evaluations lists every run, newest first, with its score and best variant.
- A run's report is reachable long after the fact — closing the tab no longer loses it.
- `GET /api/v1/runs` returns the same history, filterable by status, dataset or prompt.
  [Reference →](/api-reference/experiments)

#### Evaluations and optimize now use full conversation context

- Feedback on a session now carries its prior turns into the dataset example.
- A run replays that history before the new turn, so candidates see the real context.
- The judge and the optimizer read it too, so scores and rewrites match the conversation.

#### Optimize and experiments can now pick their baseline alias

- New `alias` field — target `staging`, `dev`, or any alias instead of `production`.
- Baseline still defaults to `production`, falling back to the latest version if none.
- Feedback-built datasets now warn (never block) if examples came from a different prompt.

#### SDK prompt version lifecycle

- Both SDKs now manage prompts end to end: create, commit, list, diff, and promote versions.
- Export and import move a version between teams or environments as one JSON document.
- Look up every trace a specific prompt version produced, from either SDK.

#### SDK tool catalog lifecycle

- `hub.tools`/`client.tools` gained: create, list, get, update, delete, versions, promote, analytics.
- Available in both TypeScript and Python SDKs — see the [Tool Catalog guide](/docs/guides/version-and-track-a-tool).

#### Apache License 2.0

- Permissive, OSI-approved, with nothing gated.
- Fork it, self-host it, or sell what you build; the AcruxCore name and logo stay trademarked.
- `@acruxcoreai/sdk` and `acruxcore` ship under the MIT license.

#### SDK 0.7.0 — Resource-based namespace pattern

- **Breaking:** All flat client methods removed. Use `hub.gateway.chat()`, `hub.prompts.render()`, `hub.traces.ingest()` etc. instead of `hub.chat()`, `hub.renderPrompt()`, `hub.trace()`.
- `hub.gateway.stream()` is now a standalone method (previously `hub.chat({stream: true})`).
- `hub.gateway.flush()` / `hub.gateway.close()` replace `hub.flush()` / `hub.close()`.

#### Evaluations are now scriptable from both SDKs

- `hub.datasets`, `hub.experiments`, `hub.runs`, and `hub.optimize` expose 19 methods for the full evaluations domain.
- Create datasets, run experiments, poll results, read reports, and promote optimizer candidates without leaving your code.

#### One-command local self-host

- New `docker-compose.local.yml` bundles Postgres, Redis, API, worker and web in one file.
- `docker compose -f docker-compose.local.yml up --build` — no `.env` to fill in first.

### Minor

- **Fixed** — the trace settings API reference showed the wrong payload-capture default.
- **Fixed** — six API reference pages showed a stale 401 error message.
- **`POST /datasets/from-feedback`** now accepts at most 100 feedback ids per request.
- **Fixed** — the Python SDK tool-calling tutorial's decorator example had a broken import.
- **Tutorial and guide pages** now show a short snippet plus a link to the full runnable script.
- **Tutorial script links** now point to scripts that were actually run and verified.
- **New guide** — [evaluate a prompt with conversation history](/docs/guides/evaluate-a-prompt-with-conversation-history).
- **New guide** — [view trace analytics](/docs/guides/view-trace-analytics).
- **New guide** — [configure trace payload capture](/docs/guides/configure-trace-payload-capture).
- **New guide** — [look up the traces a prompt version produced](/docs/guides/look-up-the-traces-a-prompt-version-produced).
- **A `LICENSE`, `TRADEMARK.md`, and `CLA.md`** now ship at the repo root.
- **Fixed** — the `/sdk` page's Python tutorial links 404'd (wrong docs path).
- **The `/sdk` page** now links five capability guides per language, and its
  code samples show a decorated tool call and session tracing.
- **Three SDK guides** — chat, tracing, and gateway routing — now show Python
  code alongside Node's.
- **Added** — an "Optimize" button on a dataset's page starts a run without rebuilding it.
- **Added** — `GET /api/v1/health` reports database and Redis reachability for load balancers and uptime monitors.
- **Terms, Privacy and the site footer** now name AcruxCore without a corporate suffix.
- **Fixed** — routing requests to OpenAI reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5`) no longer 400s with `Unsupported parameter: 'max_tokens'`; the gateway now sends `max_completion_tokens` to OpenAI, while `openai_compatible` providers keep `max_tokens`.
- **Fixed** — the model-page "Test" button works for reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5`); the connectivity ping no longer sends a 1-token cap those models can't meet.
- **Privacy** names AcruxCore as the controller for the hosted service, with a contact address.
- **New guide** — [Product tour](/docs/getting-started/product-tour): tools, streaming, traces, feedback, and evaluation in one walkthrough.
- **Fixed** — rendering a prompt with a `{% for %}` loop no longer wrongly demands the loop variable as an input.
- `/compare` pages now show AcruxCore's real one-command Docker self-host.
- `/compare`'s Self-hosting row now reads "docker compose up" for every column, matching the identical command.
- **The product name is now one word** — "AcruxCore" across the site, docs, and both SDKs.
- **SDK 0.7.1** — the rename reaches both packages' metadata; no API or behaviour change.
- **The repo README** now carries the competitor comparison table, losses and ties included.
- **The SDKs page** now links the full [TypeScript](/docs/sdk-reference/node) and [Python](/docs/sdk-reference/python) API reference.
- **Fixed** — marketing pages answered on two addresses; `/pricing/` now redirects to `/pricing`.
- **Fixed** — marketing pages showed the flat client methods SDK 0.7.0 removed.
- **11 blog post titles and 12 descriptions** were shortened so search engines stop truncating them.

## Week of 27 July 2026

### Major

#### Tracing no longer slows your model calls down

- Spans queue in the background — the model's answer no longer waits on a trace write.
- About 570 ms off every traced call, ten times what the gateway's own routing costs.
- Reading traces right after a call needs `await hub.flush()` first — both SDKs at 0.6.5.

#### Tools are now defined once, in code

- A decorated function *is* the tool — no create → commit → promote for a code-owned tool.
- **`POST /tools/sync`** commits only when the spec really changed, and moves the alias.
  [Reference →](/api-reference/tools/sync)
- Both SDKs at 0.5.0 — breaking: raw tool definitions move to `toolDefs` / `tool_defs=`.

#### Streamed gateway completions are traced

- A streamed call was billed but wrote no `llm` span, so it was invisible in traces.
- Tool spans under a streamed call were orphaned, and now nest where they belong.
- Streaming records the same span a non-streamed call does.

#### Queued evaluation runs and outbound email could stall forever

- The API and the worker could each reach a different Redis, so neither read the other's work.
- Runs sat at `queued`, and invites, verification mail and digests were never sent.
- Fixed — restart any run of yours still sitting at `queued`.

#### The judge scored correct answers as failures on feedback-derived criteria

- A feedback comment describes the reply that provoked it, not the answer you want.
- The judge read it as describing the output, so a correct rewrite could still score 0.
- **Re-run any optimize or experiment run you judged against feedback criteria.**

#### Optimize runs could fail while the rewrites were fine

- The optimizer's example showed a lone `system` message, so candidates dropped the variables.
- One bad escape in the model's JSON threw the response away; near-valid JSON is now repaired.
- A rejected candidate is now named with its reason instead of a bare failure.

#### A team member now holds exactly one role — a breaking API change

- Invites and role updates take `{"role": "editor"}`; the array form now returns `400`.
- `GET /auth/me`, `/auth/teams`, `/teams/:id/members` and `/invites` return a `role` string.
- Nobody lost access — anyone who held more than one role keeps their highest.
  [Invite a teammate →](/docs/guides/invite-a-teammate)

#### You can now use the SDK without our AI gateway

- Bring your own OpenAI-compatible key and base URL; the key never touches our servers.
- Tracing still works — the SDK reports its own spans, streaming and non-streaming.
  [SDK guide →](/docs/guides/use-the-sdk-for-chat-and-feedback)
- Both SDKs at 0.6.0, no breaking changes; an HTTP 429 now retries like a 5xx.

#### The SDK render cache could send the wrong prompt to the model

- The 60-second cache key left out your variables, so a new question got the first render.
- Variables are now part of the key, and their order does not split an entry.
- `cacheTtl` / `cache_ttl` of `0` really disables the cache instead of always serving stale.

#### `response_format` support on the gateway

- Pass structured-output requests straight through for OpenAI and Gemini models.
- Anthropic models get the same contract via an internal forced-tool-call translation — no caller-visible difference.
- Both SDKs at 0.6.6 accept `responseFormat`/`response_format` directly, like `tools`/`toolChoice`.

#### Google Analytics, gated behind a cookie-consent banner

- A cookie banner now shows once, site-wide; analytics cookies are set only if you accept.
- One consent choice covers both acruxcore.com and docs.acruxcore.com — no re-prompt.
- Change your choice any time from "Cookie preferences" in the footer.

#### SDKs now forward trace tags and metadata to the gateway

- `chat()` and `runToolLoop()` / `run_tool_loop()` pass `tags` and `metadata` as gateway headers automatically.
- `runToolLoop` also forwards them as `x-span-tags` / `x-span-metadata`, tagging each gateway LLM span.
  [New guide →](/docs/guides/tag-and-filter-traces)

### Minor

- **A "Beta" badge** in the landing hero, matching the one the signed-in app already showed.
- **A product demo** plays on the home page.
- **The home page's code panel** switches between TypeScript and Python, with a tab to pin one.
- **New writing** — a [hands-on comparison](/blog) of LangSmith, Langfuse, PromptLayer and
  AcruxCore.
- **Re-measured** — [how much overhead an LLM gateway adds](/blog/llm-gateway-overhead) now
  benchmarks five paths including bring-your-own-key, on one fresh run.
- **A real logo** — a crescent and compass rose, across the site, docs, browser tab and previews.
- **Tool release notes** are separate from the model-facing description.
- **Code-owned tool warning** in the dashboard before an edit the next deploy will supersede.
- **Tool loops route by executor type** — `http` runs on the platform, `client` runs locally.
- **Rendering a prompt now returns its version id and number**, linking a trace to that version.
- **`chat()` can thread manual calls into one trace** via `trace: { traceId, sessionId }`.
- **A bring-your-own provider URL is checked for HTTPS** — warned once if it is plain `http://`.
- **Hardening** — the gateway's token estimate is bounded, so one odd prompt cannot slow others.
- **New guide** — [build a RAG agent without the gateway](/docs/tutorials/build-a-rag-agent-without-the-gateway).
- **New guide** — [improve a prompt from feedback](/docs/guides/improve-a-prompt-from-feedback).
- **The streaming-trace post** now carries the production run that verified the fix.
- **The Quickstart's Python tab** now uses the `acruxcore` SDK instead of raw `requests`.
- **Core concepts** was rewritten around the new tool path.
- **Fixed** — a signed-in visitor clicking the public site's logo or nav was bounced into the app.
- **Fixed** — the sign-in page and the signed-in app's sidebar still showed the old placeholder mark.
- **Fixed** — list bullets stopped rendering on the site's written pages.
- **Fixed** — a run report's delta badge printed `+66.66666666666667` beside a score reading `66.7`.
- **Fixed** — errors from local development were reported to the monitor alongside production ones.
- **Fixed** — several site code samples still showed the pre-0.5.0 way of passing a prompt's tools.
- **Fixed** — the TypeScript SDK's npm package page linked a private source repo that 404s for visitors.
- **Fixed** — simultaneous tool syncs could create two tools with one name, or fail with a `500`.
- **Fixed** — a first sync targeting a custom alias reported success without creating it.
- **Fixed** — a duplicate tool name now returns `409 TOOL_NAME_TAKEN`, not a hidden second tool.
- **Fixed** — accepting the cookie banner on the site did not actually start analytics.
- **New Tutorials section** — end-to-end agent builds split out from single-feature guides.
- **New guide** — [manage team roles and permissions](/docs/guides/manage-team-roles-and-permissions).
- **New guide** — [scope access with virtual keys](/docs/guides/scope-access-with-virtual-keys).
- **New guide** — [version and track a tool](/docs/guides/version-and-track-a-tool).
- **New guide** — [automatic model fallbacks](/docs/guides/automatic-model-fallbacks).
- **New guide** — [set spend limits with gateway budgets and rate limits](/docs/guides/set-spend-limits-with-gateway-budgets-and-rate-limits).
- **New guide** — [diff, export, and import your prompt library](/docs/guides/diff-export-and-import-your-prompt-library).
- **[Evaluate a prompt](/docs/guides/evaluate-a-prompt)** now frames the baseline comparison as a pre-ship gate.
- **New writing** — [how much latency and spend exact-match gateway caching actually saves](/blog/exact-match-gateway-caching).
- **New writing** — [comparing Anthropic, OpenAI, and Gemini request shapes behind one gateway API](/blog/one-gateway-three-providers).
- **Fixed** — a malformed prompt id in the URL returned a raw `500` instead of a clear `400`.
- **Fixed** — deleting a tool could leave a secret it referenced permanently undeletable.
- **New guide** — [tag and filter traces](/docs/guides/tag-and-filter-traces).
- **New tutorial** — [build a ReAct agent](/docs/tutorials/build-a-react-agent) with a real Yahoo Finance news tool.
- **New tutorial** — [build a configurable ReAct agent](/docs/tutorials/build-a-configurable-react-agent) with real Tavily search.
- **New tutorial** — [build a supervisor multi-agent system](/docs/tutorials/build-a-supervisor-multi-agent-system) with real finance/research/writing subagents.
- **New tutorial** — [build a Medical-Information QA agent](/docs/tutorials/build-a-medical-information-qa-agent) demonstrating `response_format`.

## Week of 20 July 2026

### Major

#### Self-hostable authentication

- Auth moved from Supabase to Better Auth, so no hosted identity provider is needed.
- Existing sessions and sign-in flows are unchanged.

#### API keys are hashed at rest and shown once

- A key is displayed a single time when created, then stored only as a SHA-256 hash.
- Keys created before this change were removed — they could not be migrated.

#### Transactional email, event notifications and a weekly usage digest

- Invites, email verification and password resets now send real mail.
- Each team can opt in to event notifications and a weekly usage summary.
- Every message carries a one-click unsubscribe.

#### Python SDK

- `acruxcore` on PyPI — async, and at parity with the TypeScript SDK.
- Prompt render, gateway chat and streaming, tool loops, traces and feedback.
- Shipped with a text-to-SQL agent guide.

### Minor

- **Prompt default model** — a render no longer repeats the model the prompt was written for.
- **Error monitoring** across the API, the worker and the dashboard.
- **A security hardening pass** across the gateway, prompt rendering, membership and traces.
- **The public site and docs site** were rebuilt for launch, including SEO and footer pages.
- **Fixed** — a worker start-up race could silently drop the email, eval-run and digest workers.
- **Fixed** — clicking the in-app logo now opens the landing page instead of doing nothing.

## Week of 13 July 2026

### Major

#### One trace per agent run

- A client-side tool loop threads a trace id, so a multi-step run is a single trace.
- The gateway's `llm` spans and your `tool` spans appear in one tree.
- Previously every model call produced a trace of its own.

#### Tool calls run in parallel

- When a model asks for several tools at once, the loop dispatches them concurrently.
- Previously they ran one after another.

#### The SDK gained the core LLM methods

- Chat, streaming and feedback, alongside prompt rendering.
- An agent no longer needs a provider client of its own.

### Minor

- **Trace payload capture** is on by default for new teams, and stays switchable per team.
- **The [API reference](/api-reference)** was reorganized by domain and is curl-verified.
- **New guide** — [a tool-calling agent in Python without the SDK](/docs/tutorials/build-a-tool-calling-agent-in-python-no-sdk).
- **New guide** — [a tool-calling agent in the dashboard, no code](/docs/tutorials/build-a-tool-calling-agent-in-the-dashboard-no-code).
- **New guide** — [storing prompts and tools via the API](/docs/guides/store-prompts-and-tools-via-api).
- **Fixed** — a tool or trace name with non-ASCII characters could break the gateway request.

---

This changelog starts on 13 July 2026. Anything before that predates the public beta.
