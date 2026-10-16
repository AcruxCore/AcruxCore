# Run log: the scope-check app on AcruxCore

The same app, data, prompts and scorers as `scripts/blogs/langfuse-vs-langsmith/`, run on
AcruxCore Cloud (`acruxcore.com`, production) on 16 October 2026, the same day as the Langfuse and
LangSmith runs. Every model call goes to z.ai `glm-5.3` with `reasoning_effort="low"`, straight
from the app, as in the other two legs. Raw outputs are in `records/`.

`python/common.py`, `pipeline.py`, `scoring.py`, `diff_runs.py`, `data/` and `prompts/` are
byte-for-byte copies of the files in `scripts/blogs/langfuse-vs-langsmith/`, except for one
docstring line in `common.py`.

## Step 0: setup

- **Team:** the demo team on production (`demo@acruxcore.com`). The account has one team and no
  team switcher, so the run did not get its own team. Every object it creates starts with `scope-`.
- **API key:** the owner created a personal API key in Account & keys and put it in the repo `.env`
  as `ACRUXCORE_PROD_API_KEY` (a first key, `scope-check-three-platforms`, was created by the agent and
  its value lost when the tab navigated away; the owner was asked to revoke it).
- **z.ai credential:** the owner added it under Gateway → Credentials: provider `openai_compatible`,
  label `Z.ai`, base URL `https://api.z.ai/api/coding/paas/v4`.
- **Model price:** `POST /gateway/models` registered `glm-5.3` (upstream `glm-5.3`, credential
  `Z.ai`) with z.ai's list price, $1.40 input and $4.40 output per 1M tokens
  (`records/01-acruxcore-register-model-glm-5.3.json`). The model form has no cached-input price,
  so cached input tokens are charged at the full input price.
- **Python:** one clean venv, Python 3.12 via `uv`, with `openai==2.48.0`, `httpx` and
  `python-dotenv` (`records/00-pip-freeze-acruxcore.txt`, 17 lines). No `acruxcore` package: the
  AcruxCore Python SDK is async only (`AcruxCore` client, every method `async def`), and the app
  is synchronous like the other two legs, so the leg calls the REST API with `httpx`.

### Why the app does not route through the AcruxCore gateway

AcruxCore's main design puts the gateway in the request path. We checked that path first with a
small prompt sent twice each way (`records/02-gateway-reasoning-effort-check.txt`):

| Path | `reasoning_effort` sent | completion tokens (run 1 / run 2) |
|---|---|---|
| z.ai directly | `low` | 17 / 27 |
| z.ai directly | none | 88 / 68 |
| AcruxCore gateway | `low` | 62 / 83 |

The gateway accepted the request but did not pass `reasoning_effort` on to z.ai, so the model
thought at its default effort. Its `usage` also had no `cached_tokens` or `reasoning_tokens`
detail. Routing the app through the gateway would therefore have run a different model setting
from the other two legs. The leg instead calls z.ai directly and sends the spans to AcruxCore,
which is the same position Langfuse and LangSmith take. Filed as an issue.

## Step 1: instrument and trace one message

`python/acruxcore_leg.py`, between the `# --- instrumentation` markers:

- `client` wraps `chat.completions.create`: it calls z.ai, then records an `llm` span with the
  model, token usage, the prompt version id, the messages and the reply.
- `step(name, kind)` is a decorator that records a `chain` or `tool` span. The outermost step
  posts the whole trace in one `POST /traces` call when it ends.
- `prompt_version(name, alias)` reads the alias, then the version, through two REST calls, cached
  for 60 seconds (the Langfuse SDK's default).

First run: `POST /traces` returned 400 because spans carried `null` for optional fields
(`parentSpanId` on the root, `promptVersionId` on non-llm spans). The schema accepts a missing
field but not `null`; the leg now drops `None` values.

`run --id msg-06` (`records/05-acruxcore-run-msg-06.txt`): 15.8 s, total $550, correct items.
Trace `5db76699-6e4b-4bac-b56b-c96960582f41` (`records/05-acruxcore-trace-msg-06.json`): 10
spans, 2,180 tokens, **$0.003844**. Each `llm` span was priced at ingest from the team's model
price, and each carries the prompt version id.

Tree as stored: `scope-check` → `extract` (llm) → 2 × `classify` (llm) → `price` (tool) →
`reply` (llm). Screenshot: `screenshots/01-acx-trace-tree.jpg`.

The `llm` span panel shows model, tokens, cost and latency, and a link "View traces for this
prompt version →", plus "Open in Playground →". The panel does not print the prompt's name or
version number (`screenshots/02-acx-llm-span-prompt-link.jpg`).

## Step 2: prompts

`push-prompts --version 1` (`records/03-acruxcore-push-prompts-v1.txt`): four prompts created,
one version each. The first commit created `production` and `staging` aliases on v1
automatically. The stored `scope-classify` messages are identical to the JSON file, and AcruxCore
derived the variables `rate_card, received, request, scope` from the `{{ }}` placeholders.

## Step 3: dataset

`push-dataset` (`records/04-acruxcore-push-dataset.txt`): one bulk call, 30 examples, 0.8 s.
An AcruxCore example has `input` (variables) and `criteria` (text for the judge). There is no
structured expected-output field, so the labels are stored as JSON text in `criteria`.

## Step 4: experiment v1

AcruxCore's experiments run server-side: one stored prompt, its versions × models, scored by an
LLM judge against each example's `criteria`. They cannot run this app (four steps plus Python) or
the two code scorers. The leg therefore runs the app over the dataset itself, with a thread pool
of 4, and stores the three scores as feedback on each trace (`rating` ±1, label
`items_exact:pass` etc., source `developer`).

`experiment --name v1` (`records/06-acruxcore-experiment-v1.txt`,
`records/acruxcore-experiment-v1-results.json`): 30/30, no errors, **129.2 s**.
items_exact 26, total_exact 29, reply_judge 27.

## Step 5: human review

AcruxCore has no annotation queue. Review happens on each trace page.

Per message, from the Traces list: open the trace (1), open the `reply` step to read its output
(1), click ▲ or ▼ on that step (1), go back (1): **4 clicks**. The thumb saves at once, as a
rating with no label or question. Clicked in the browser for msg-30 and confirmed by
`GET /traces/:id/feedback` (rating 1, on the reply span).

The Traces list shows each row's name (`scope-check`), not the message, so finding a given
message means opening rows.

The verdicts for all 30 messages were made by reading every reply
(`records/07-acruxcore-human-verdicts-v1.json`). msg-30 was saved in the browser; the other 29
were saved through `POST /traces/:id/feedback` with the same shape (rating on the `reply` span),
plus a comment on the two failures (`records/07-acruxcore-human-review-v1.txt`).

- 28 send as is, 2 need a fix: msg-03 (charges the booking item twice, $2,800 instead of $1,400)
  and msg-21 (calls the copy-to-sender email in scope; it needs an estimate).
- The items scorer failed 4 messages (msg-03, 05, 21, 24). We would send 2 of those replies as is
  (msg-05 splits two pages into two lines with the right total; msg-24 lists one clause twice).

## Step 6: prompt v2

The same v2 files as the other two legs. `push-prompts --version 2 --names
scope-extract,scope-classify`, then `promote --alias candidate --version 2`
(`records/08-acruxcore-push-prompts-v2.txt`). Committing v2 did not move `production`.

## Step 7: experiment v2 and compare

`experiment --alias candidate --only scope-extract,scope-classify --name v2`
(`records/09-acruxcore-experiment-v2.txt`, `records/acruxcore-experiment-v2-results.json`):
30/30, no errors, **133.9 s**. items_exact 27, total_exact 30, reply_judge 29.

Per message (`records/09-acruxcore-v1-vs-v2-diff.txt`):

```
items_exact: A 26 -> B 27 | fixed ['msg-03', 'msg-05'] | broke ['msg-10']
total_exact: A 29 -> B 30 | fixed ['msg-03'] | broke []
reply_judge: A 27 -> B 29 | fixed ['msg-03', 'msg-21', 'msg-28'] | broke ['msg-24']
```

These two runs are traces with feedback, not experiment objects, so AcruxCore has no view that
compares them. Its comparison view works on its own server-side runs. To use it, we ran one on the
step that has a judgeable output, `scope-extract` (`server-experiment`,
`records/12-acruxcore-server-experiment-extract-v1-v2.txt`):

- A new dataset `scope-extract-check`: 30 examples, input `{message}`, criteria "exactly N separate
  requests, one per expected item: …" built from the labels.
- Experiment `scope-extract v1-v2`: versions v1 and v2 × `glm-5.3`, judge `glm-5.3` (built-in
  judge). These calls go through the gateway, so they ran at the model's default reasoning effort
  (issue #593).
- Run `5cd7ec99-8672-47f2-b34d-bc8b57e10e77`: 60 cells, 0 errors, 441 s (`records/12-acruxcore-server-run*.json`).
  v1 80.5 average, 22/30 pass; v2 88.2, 26/30 pass, "+7.7 improved".
- `GET /runs/:id/compare?base_cell=v1|glm-5.3&target_cell=v2|glm-5.3`
  (`records/13-acruxcore-compare-v1-v2.json`): improved 4, regressed 0, unchanged 26.

Clicks from the Datasets page to the changed examples: Runs tab (1), the run (2), "Compare per
example" (3). The page opens filtered to "Changed 4" and lists the four messages with base and
target pass/fail and score. **3 clicks, no scrolling.** The dataset page itself does not list the
runs made from it. Screenshots: `screenshots/03-acx-run-report.jpg`,
`screenshots/04-acx-compare-per-example.jpg`.

## Step 8: promote and roll back

Prompt page → Versions tab: each version row has one button per alias ("→ production",
"→ staging"). From the prompt list: open the prompt (1), Versions (2), "→ production" (3).

The agent's click on "→ production" was blocked by the Claude Code permission check ("Production
Deploy"), so this step is waiting for the owner to click it.

## Rerun on the current product: preparation (2026-10-16, evening)

#593 (gateway `reasoning_effort`), #594 (cached-token pricing) and #596 (local experiments) are
on `main` and deployed. Steps 1–7 above ran before them, so their numbers are kept as a record
only, and the post waits for a rerun of steps 3–9 on the current product.

**Blocked, as of 2026-10-16 ~22:00 PKT:**

- The z.ai key in `.env` (`Z_AI_TEMP_KEY`) answers 1113 "Insufficient balance or no resource
  package" for every paid model on both endpoints. That includes `glm-5.3`, `glm-5.2`, `glm-5.1`,
  `glm-5`, `glm-4.7`, `glm-4.6`, `glm-4.5-air` and the `glm-5.3-flash` variants. The free
  `glm-4.5-flash` works.
- The auto-mode permission check refuses writes to acruxcore.com production ("Modify Shared
  Resources"), starting with `PATCH /gateway/models/:id` for the cached price.

**Script changes (`python/acruxcore_leg.py`):**

- Spans send `usage.cachedTokens`.
- `push-dataset` stores the labels in `expected`, in a new dataset `scope-check-expected`.
- `experiment` is a local run: `POST /experiments/local`, then `POST /runs/:id/results`, then
  `POST /runs/:id/finish`.
- `server-experiment` is replaced by `gateway-check`.
- `SCOPE_MODEL` (in `common.py`) and `SCOPE_RECORDS` override the model and the records folder.
- The instrumentation is still 68 lines.

**New `python/live_stats.py`** reads root-trace latency and stored cost back from all three APIs.
Over the Langfuse vs LangSmith live window (2026-10-16 06:03:30–06:13:30Z) it reproduces that
post's published figures exactly (`records/16-…`): p50 16.84 s / 16.89 s, p95 31.55 s / 29.94 s,
cost per trace $0.00158 / $0.001795.

**Dry run on the local stack.** This used the API from the `local-experiments-596` worktree on
:3596, a local demo team and the free `glm-4.5-flash`. Its output is in the session scratchpad,
not in `records/`.

- One traced message: the first llm span, priced at $1.40 / $0.26 / $4.40 per 1M, was stored
  with 137 cached tokens. Its cost was $0.00101382, which is exactly 1 × 1.40 + 137 × 0.26 +
  222 × 4.40 per 1M. Cached pricing works on ingested spans.
- Local run v1 at concurrency 8:
  - created, uploaded and finished as `succeeded` in 127.7 s;
  - 27 of 30 examples hit the free model's rate limit (1302), and those were uploaded as
    errored results. The flow itself works.

**Step 8 on the local dashboard** (the same web code as production):

- The "→ production" button opens a dialog: "Update production? Point the production alias at
  v2. This changes what the SDK serves immediately." The button in it is "Promote to production".
- A promotion takes 4 clicks from the prompt list. A rollback takes 2 more on the same tab
  ("→ production" on v1, then confirm).
- The Audit tab listed both moves only as "Alias promoted production", with no versions.
  The API stores `fromVersionNumber` and `toVersionNumber`, but the tab never read them.
  Fixed in PR #605 (separate branch from staging): the tab now shows "production · v1 → v2".

### Rerun checklist (on acruxcore.com, once z.ai credits and prod-write permission are back)

1. `PATCH /gateway/models/14a67007-9710-4b00-9b06-dd6d0d64d178 {"cachedInputPricePerM": 0.26}`.
   If the model changes (`SCOPE_MODEL=glm-5.2`), register that model with its own z.ai prices
   first, and run the Langfuse and LangSmith live legs on the same model.
2. `gateway-check`: completion and reasoning tokens with `reasoning_effort="low"` and with the
   default, and the `x-gateway-params-ignored` header (expected: empty).
3. `push-dataset` creates `scope-check-expected`. Record the seconds.
4. `experiment --name v1`. Then human review of the 30 v1 traces (4 clicks each), with
   `review.py` for the verdicts.
5. `experiment --alias candidate --only scope-extract,scope-classify --name v2` (`candidate`
   already points at v2 on production). Use concurrency 2 if z.ai answers 429.
6. In the dashboard: Evaluations → Runs → v1 → Compare per example, on the items score.
   Take screenshots of the run report and the comparison.
7. Step 8: on the Versions tab, "→ production" on v2 for scope-extract and scope-classify, then
   confirm. Run `run --id msg-06` and check the trace's promptVersionId is v2. Roll back to v1.
   Take a screenshot of the Audit tab (needs PR #605 deployed).
8. Step 9: start `acruxcore_leg.py live`, `langfuse_leg.py live` and `langsmith_leg.py live`
   together. Then `live_stats.py --since … --until …` over the window.
9. Retake `acx-trace-tree.jpg` and `acx-llm-span-prompt-link.jpg` with the new costs. Fill every
   TBD and remove the Draft boxes.

## Rerun on the current product: results (2026-10-16, 22:05–22:25 PKT)

The owner put a new z.ai key in `.env` and in the production "Z.ai" credential, and set
`glm-5.3`'s cached input price to $0.26 in the dashboard (`records/14-…cached-price.json`).

- **Gateway check** (`records/15-…`): one extract call through the gateway. With
  `reasoning_effort="low"` it used 3 reasoning tokens (80 completion tokens). With no setting it
  used 149 (188 completion tokens). `x-gateway-params-ignored` was empty both times.
- **Dataset** `scope-check-expected` (`records/17-…`): 30 examples, labels in `expected`, one
  bulk call, 1.0 s.
- **Local run v1** `9aa186b5-f11b-4a10-b697-deef9b0962a5` (`records/18-…`): 30/30, 0 errors,
  95.4 s. items 27, total 29, judge 29.
- **Human review v1** (`records/19-…`, `records/07-acruxcore-human-verdicts-v1.json`): 28 send
  as is, 2 need a fix.
  - msg-21: shows the client an internal pricing note, and the total is wrong.
  - msg-24: invents a "maintenance package" and a separate domain-migration estimate.
  - The items scorer failed msg-05, msg-21 and msg-24. msg-05's reply is fine.
  - The ratings were posted through the API on each reply span. The click count, 4 per
    message, is from the first run; the UI has not changed since.
- **Local run v2** `bf57a013-7179-4c99-adbb-763a9f6b445c` (`records/20-…`, `21-…`): 30/30,
  0 errors, 97.6 s. items 27, total 30, judge 30. Items: fixed msg-05 and msg-21, broke msg-10
  and msg-27.
- **Compare per example** on acruxcore.com (screenshots 05, 06): Evaluations → Runs → v1 →
  "Compare per example". The page defaults to target v2 and opens on "Changed 4": Improved 2
  and Regressed 2, the same as the diff. The dataset page does not list runs (checked on the
  same web code locally).
- **Step 8:** the "→ production" click on acruxcore.com was refused by the permission check
  ("Production Deploy"). This step waits for the owner.
- **Step 9 live traffic**, all three legs started together (`records/22-*`). Window
  17:17:48–17:22:25Z, 30 traces each, production = v1. Measured by `live_stats.py`
  (`records/23-…`):

| | AcruxCore | Langfuse | LangSmith |
|---|---|---|---|
| p50 / p95 / max (s) | 7.65 / 10.64 / 12.36 | 7.18 / 10.84 / 12.92 | 7.61 / 11.19 / 11.77 |
| Cost per trace, mean | $0.001616 | $0.001541 | $0.001693 |

  AcruxCore's stored cost equals a recomputation from span tokens at $1.40/$0.26/$4.40 per 1M
  ($0.048486; `records/24-…`). 85% of input tokens were cached. At the full input price, the
  same traces would cost $0.087885. The model was about twice as fast as in the Langfuse vs
  LangSmith run that morning (p50 16.9 s then), so this post's latencies apply only to this
  window.
- Screenshots 07–09 (trace tree, LLM span with "Cached prompt tokens", and the Traces list with
  cost and duration) replace the first run's images in the post.

## Step 8 on acruxcore.com (2026-10-16, 22:33–22:44 PKT)

- The owner clicked "→ production" on v2, then "Promote to production", on scope-extract and
  scope-classify. The agent's own click had been refused by the permission check.
- `run --id msg-06` (`records/25-…`), with no code change: trace
  `b9019c99-b23c-4ead-ac84-e3b02e422156`. The extract step and both classify steps carry the v2
  prompt version ids, and reply carries v1 (its alias did not move).
- The owner rolled back to v1 on both prompts. The aliases read `production: 1` again. The audit
  rows hold `fromVersionNumber`/`toVersionNumber` for both moves.
- PR #605 shipped in release #608 (deploy of `ea623fe`). The Audit tab now reads
  "production · v1 → v2" and "production · v2 → v1" (screenshot 10).

The post is complete. There are no Draft boxes, the docs build is clean, and three
fresh-reader passes were run and fixed.

## SDK leg after PR #613 (2026-10-17, local API, not yet in the post)

PR #613 added `AcruxCoreSync`, `traces.step` and `prompts.get_by_alias` to the Python SDK, to
shrink this leg. `python/acruxcore_sdk_leg.py` is the same app on that SDK, with z.ai called by
the SDK itself (bring your own key), as in the other two legs.

- **Instrumentation: 15 lines**, counted like the others (non-blank, non-comment lines between
  the markers; `records/28-…`): old leg 68, Langfuse 11, LangSmith 18.
- What is left over the other two: a 3-line shim that gives `gateway.chat()` the
  `client.chat.completions.create` shape the shared `pipeline.py` calls. Langfuse and LangSmith
  ship a wrapped OpenAI client instead.
- `run --id msg-06` (`records/26-…`): 9.1 s, total $550, both items right. Stored trace: 10
  spans, the same tree as step 1, each `llm` span with its prompt version id, 2,191 tokens.
- `experiment --name sdk-leg-v1`, 4 threads (`records/27-…`): 0 errors, items 26 / totals 30 /
  judge 29 (the hosted v1 local run had 27 / 29 / 29). All 30 rows carry a different trace id,
  and each trace's root input is that row's own message.
- Run on a local API built from staging (`ce6111a`), with the SDK from `packages/sdk-python/src`.
  The local team has no price for `glm-5.3`, so the trace shows no cost. A run on acruxcore.com
  was not made: the SDK is not published, and the hosted API has not had the release yet.

The post now shows the SDK leg (15 lines). Before it goes live: publish the SDK, release the
API to acruxcore.com, then run this leg there with `pip install acruxcore` (`run --id msg-06` and
a check that its trace matches step 1), and add the installed version to the environment line.
