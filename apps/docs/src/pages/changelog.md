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

## Week of 5 August 2026

### Major

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

- **New guide** — [Product tour](/docs/getting-started/product-tour): tools, streaming, traces, feedback, and evaluation in one walkthrough.
- **Fixed** — rendering a prompt with a `{% for %}` loop no longer wrongly demands the loop variable as an input.
- `/compare` pages now show AcruxCore's real one-command Docker self-host.
- `/compare`'s Self-hosting row now reads "docker compose up" for every column, matching the identical command.

---

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
- Available in both TypeScript and Python SDKs — see the [Tool Catalog guide](/docs/guides/manage-a-tools-lifecycle-via-the-sdk).

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
- **A `LICENSE`, `TRADEMARK.md`, and `CLA.md`** now ship at the repo root, under
  [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license).
- **Fixed** — the `/sdk` page's Python tutorial links 404'd (wrong docs path).
- **The `/sdk` page** now links five capability guides per language, and its
  code samples show a decorated tool call and session tracing.
- **Three SDK guides** — chat, tracing, and gateway routing — now show Python
  code alongside Node's.
- **Added** — an "Optimize" button on a dataset's page starts a run without rebuilding it.

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
- **New guide** — [alias and track usage of tools in the catalog](/docs/guides/alias-and-track-usage-of-tools-in-the-catalog).
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
