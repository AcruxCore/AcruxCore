# Run log: Langfuse vs LangSmith, end to end

Every step of the comparison run, in order, with the exact command and what came back. Raw
outputs are in `records/`, screenshots in `records/screenshots/`. Times are Asia/Karachi
(UTC+5) unless marked UTC. The spec is
`docs/superpowers/specs/cross-cutting/2026-10-16-langfuse-vs-langsmith-post-design.md`.

This file keeps everything, including things the post will not use.

## Step 0 — Accounts, keys, model, environments (2026-10-16)

### Accounts

- **Langfuse Cloud EU** (`https://cloud.langfuse.com`), org `autovidify` (Hobby plan), new
  project `langfuse-vs-langsmith` (id `cmvahd5rm0b0xad0k7r8rgfdp`). The project was created in
  the browser by the agent. API key pair created from the project's "Create new API key"
  button. Check: `GET /api/public/projects` with basic auth → HTTP 200.
- **LangSmith EU** (`https://eu.smith.langchain.com`), org `24efd6a9-61ac-434f-9426-6a082c6b512d`
  (Personal), Workspace 1. Personal Access Token created in Settings → API Keys (type
  "Personal Access Token", expires 1 year). Check: `GET /api/v1/sessions?limit=1` with
  `x-api-key` → HTTP 200, `[]`.
- The LangSmith root page `eu.smith.langchain.com/` shows the sign-up page even when signed in;
  the org URL `/o/<org-id>` opens the account. The US domain `smith.langchain.com` is blocked in
  the Chrome extension's site permissions; the EU domain is not.
- Region: EU on both (owner decision, FAQ Q101). Region can't be changed later on either
  product.

### Model: z.ai GLM-5.3 (owner decision 2026-10-16, replaced gpt-5.4-mini via OpenRouter)

Key in `.env` as `Z_AI_TEMP_KEY`. Endpoint test, one message "Reply with exactly: connection ok":

| Endpoint | Body | Result |
|---|---|---|
| `https://api.z.ai/api/paas/v4/` (general, pay per token) | `thinking: {type: disabled}` | HTTP 400, code 1210 "This model always engages in thinking and cannot be disabled; please use low, high, or max" |
| same | `reasoning_effort: low` | code 1113 "Insufficient balance or no resource package. Please recharge." |
| same | default | code 1113, same |
| `https://api.z.ai/api/coding/paas/v4/` (Coding Plan) | `thinking: {type: disabled}` | HTTP 200, "connection ok", 0 reasoning tokens, 11.4 s |
| same | `reasoning_effort: low` | 200, "connection ok", 0 reasoning tokens |
| same | default | 200, "connection ok", 26 reasoning tokens, 129 chars of `reasoning_content` |

Decision: Coding Plan endpoint (the only one this key can use), `reasoning_effort="low"`
(works on both endpoints; "disabled" fails on the general one), model id `glm-5.3`.

JSON mode: `response_format: {type: json_object}` works on the Coding Plan endpoint. Two calls of
the extract prompt on "Can we add a blog and a Spanish version?" returned valid JSON with two
requests, 2.1 s and 7.8 s, 4–5 reasoning tokens each. The response carries a
`reasoning_content` field next to `content`.

### UI model connections (both tested with one message, both answered "connection ok")

- Langfuse: Project Settings → LLM Connections → provider `Z.ai`, OpenAI adapter, base URL
  `https://api.z.ai/api/coding/paas/v4/`, custom model `GLM-5.3` (added by the owner). Tested
  in Playground.
- LangSmith: two places. The key is a workspace secret `ZAI_API_KEY` (Settings → Provider
  secrets; added by the owner). The "Allowed hosts" field rejects a URL with a scheme or path
  ("Enter a bare hostname, without a scheme, path, or port"); the owner saved it with no hosts,
  so LangSmith shows "No hosts · not usable in sandboxes or evaluators". The base URL lives in
  Settings → Model configurations → Create (added by the agent): provider OpenAI, model
  `GLM-5.3` typed as a custom name, API Key Name `ZAI_API_KEY`, Provider API changed from
  "Responses (Recommended)" to "Chat Completion", Base URL as above, saved as preset
  `zai-glm-5.3`. Save asks for a preset name in a second dialog. Tested in Playground: answered
  in 1.78 s.

### Python environments

Two clean venvs, one per leg, Python 3.12 via `uv`, so a hidden system package can't make a leg
look lighter than it is. Package lists: `records/00-pip-freeze-langfuse.txt` (36 lines) and
`records/00-pip-freeze-langsmith.txt` (30 lines). Neither contains a `langchain*` package.

```
uv venv --python 3.12 venv-langfuse  && uv pip install langfuse==4.14.1 openai==2.48.0 python-dotenv
uv venv --python 3.12 venv-langsmith && uv pip install langsmith==0.10.10 openai==2.48.0 python-dotenv
```

### SDK facts read from the installed source (not docs)

- LangSmith `Client.create_commit` (used by `push_prompt`): if the object is not already a
  serialized LangChain manifest (a dict with `"lc"` and `"id"` keys), it imports
  `langchain_core.load.dumps` and raises `ImportError("The client.create_commit function
  requires the langchain-core package…")` when that is missing.
- LangSmith `Client.pull_prompt` docstring: "Pull a prompt and return it as a LangChain
  `PromptTemplate`. This method requires `langchain-core`." `pull_prompt_commit` returns the raw
  manifest and does not.
- LangSmith signatures checked: `push_prompt(identifier, *, object, parent_commit_hash, is_public,
  description, readme, tags, commit_tags, commit_description)`, `create_dataset`,
  `create_examples(dataset_name|dataset_id, examples, max_concurrency≤3)`,
  `create_annotation_queue(name, description, rubric_instructions, rubric_items)`,
  `add_runs_to_annotation_queue(queue_id, run_ids)`, `create_feedback`, `evaluate(target, data,
  evaluators, experiment_prefix, max_concurrency, num_repetitions, …)`, `wrap_openai(client)`,
  `traceable`.
- Langfuse signatures checked: `get_prompt(name, version, label, type)`, `create_prompt(name,
  prompt, labels, tags, type, config, commit_message)`, `update_prompt(name, version,
  new_labels)`, `create_dataset`, `create_dataset_item(dataset_name, input, expected_output,
  metadata, source_trace_id, …)`, `get_dataset`, `run_experiment(name, run_name, description,
  data, task, evaluators, run_evaluators, max_concurrency=50, metadata)`, `create_score`,
  `observe(name, as_type ∈ generation|span|agent|tool|chain|…)`. Annotation queues exist only
  under `langfuse.api.annotation_queues` (no top-level helper).

## Shared code (written 2026-10-16 ~10:00)

- `python/common.py`: model `glm-5.3`, base URL (env `ZAI_BASE_URL`, default Coding Plan), key from
  `ZAI_API_KEY` or `Z_AI_TEMP_KEY`, `MODEL_PARAMS = {"reasoning_effort": "low"}`, data loaders,
  `render()` (plain `{{var}}` replacement, no HTML escaping).
- `python/pipeline.py`: `build_app(get_prompt, client, step)`. The legs differ only in those
  three arguments. Every LLM step uses `response_format: json_object` except the reply.
- `python/scoring.py`: `items_exact` (one-to-one match: status, plus clause ∈ acceptable list for
  in_scope, plus rate_item and quantity for out_of_scope), `total_exact`, `judge_reply`.

### Untraced smoke test (plain OpenAI client, local prompt files) — `records/01-smoke-untraced.json`

| msg | seconds | items | total | judge |
|---|---|---|---|---|
| msg-06 | 10.4 | ✓ | ✓ | PASS |
| msg-15 | 24.7 | ✗ | ✗ | FAIL — "quotes $240 instead of the expected $120 … fails to ask … about the Instagram ads connection" |
| msg-27 | 16.8 | ✓ | ✓ | PASS |

## Step 1 — Instrument and trace one message

### Langfuse (10:08)

Code: `python/langfuse_leg.py`, instrumentation block saved as
`records/07-instrumentation-langfuse_leg.py`: **11 non-blank, non-comment lines**. Uses
`langfuse.openai.OpenAI` (drop-in), `observe(name, as_type="span"|"tool")`, and
`get_prompt(..., label=..., type="chat")` passing `langfuse_prompt=prompt` into
`chat.completions.create` to link the call to the version.

`python langfuse_leg.py run --id msg-06` → 11.3 s wall, total 550 (correct). Output:
`records/04-langfuse-run-msg-06.txt`. Trace `7715195d6e7a380f90021d98b3488105`, JSON in
`records/04-langfuse-trace-msg-06.json`.

- First API read right after the run returned latency 4.047 and an observation whose parent was
  missing: ingestion was still in progress. 20 s later: complete, latency 10.15 s, 10
  observations.
- Tree: `scope-check` span → `extract` span → `OpenAI-generation`; 2 × `classify` span →
  generation; `price` TOOL; `reply` span → generation. Generation name defaults to
  `OpenAI-generation`.
- Each generation carries `promptName` and `promptVersion` (e.g. scope-extract 1). In the UI the
  generation header shows "prompt: scope-extract - v1 ↗" as a link
  (`screenshots/05-langfuse-generation-prompt-link.jpg`).
- Usage per generation: `input` excludes cached tokens and is reported separately as
  `input_cached_tokens` (e.g. classify: input 36, cached 704, output 55, total 795).
  `output_reasoning_tokens: 0` on all four with `reasoning_effort=low`.
- **Cost: 0 / "no cost"**. Langfuse has no price for `glm-5.3`; the UI shows a warning icon with
  "no cost" in the generation header.
- Screenshot: `screenshots/01-langfuse-trace-tree.jpg`.

### LangSmith (10:10)

Code: `python/langsmith_leg.py`, instrumentation block saved as
`records/07-instrumentation-langsmith_leg.py`: **17 non-blank, non-comment lines**. Uses
`wrap_openai(OpenAI(...))`, `traceable(name, run_type="chain"|"tool")`, and
`pull_prompt_commit("name:tag")` with a hand-written unpacker for LangChain's serialized
manifest (6 of the 17 lines), because `pull_prompt` returns a LangChain object and needs
langchain-core. Link to the commit is passed as run metadata `lc_hub_repo` +
`lc_hub_commit_hash` via `langsmith_extra` (the same keys LangSmith's own `pull_prompt` sets,
`client.py:499-501`).

`python langsmith_leg.py run --id msg-06` → 11.4 s, total 550 (correct). Output:
`records/06-langsmith-run-msg-06.txt`; runs JSON `records/06-langsmith-trace-msg-06.json`.
Trace `01a1431e-98d3-7ff2-960b-f050201668c0`, project `scope-check` (created automatically by the
first trace, id `95d6b926-bf1f-49f8-8e03-68fbf6dd741d`).

- Tree: `scope-check` chain → `extract` chain → `ChatOpenAI` llm (model glm-5.3); 2 × `classify`
  → llm; `price` tool; `reply` → llm. LLM run name defaults to `ChatOpenAI`.
- Root shows total tokens 2167. **Cost: None** — no price for glm-5.3 either.
- Hovering the llm run shows a token breakdown: input 85 (cache read 64), output 24, total 109
  (`screenshots/03-langsmith-llm-run-token-breakdown.jpg`).
- The prompt link shows only as plain metadata text (`lc_hub_commit_hash`, `lc_hub_repo`) under
  Attributes → Metadata, not as a link
  (`screenshots/04-langsmith-llm-run-metadata-prompt-link.jpg`). Runtime metadata lists empty
  `langchain_core_version` / `langchain_version`, `library: langsmith`.
- Screenshot: `screenshots/02-langsmith-trace-tree.jpg`.

Screenshot note: the Chrome extension saves JPEG at 1456x823 even after resizing the window to
1280x800. Raw captures are kept; post images get resized later.

## Step 2 — Prompts in the registry

### Langfuse (10:08)

`python langfuse_leg.py push-prompts --version 1 --label production` → 2.2 s for 4 prompts, each
"Langfuse version 1 labels ['production', 'latest']" (`records/03-langfuse-push-prompts-v1.txt`).
`{{var}}` syntax used as is.

### LangSmith (10:09)

1. Without langchain-core (`venv-langsmith`): `push_prompt` with a list or a dict of messages →
   `ImportError: The client.create_commit function requires the langchain-corepackage to run.`
   (`records/02-langsmith-push-without-langchain.txt`). Side effect: the prompt
   `probe-no-langchain` was created empty, because `push_prompt` creates the prompt before the
   commit fails.
2. With langchain-core 1.6.10 in a separate `venv-langsmith-setup` (36 packages, adds
   `langchain-core` and `langchain-protocol`): `python langsmith_push_prompts.py --version 1 --tag
   production` → 7.0 s for 4 prompts (`records/05-langsmith-push-prompts-v1.txt`). Needs
   `ChatPromptTemplate.from_messages(..., template_format="mustache")` to keep `{{var}}`, and
   role names `system`/`human`/`ai`. 25 non-blank lines for this setup script.
3. Pulling without langchain-core works with `pull_prompt_commit("scope-extract:production")`,
   which returns LangChain's serialized manifest (`records/05-langsmith-manifest-scope-extract.json`):
   `kwargs.messages[i].id[-1]` = `SystemMessagePromptTemplate` / `HumanMessagePromptTemplate`, text
   at `kwargs.prompt.kwargs.template`.

### Prompt pages (10:11)

- Langfuse prompt page (`screenshots/06-langfuse-prompt-page.jpg`): version list with labels
  `production` and `latest`, commit message, tabs Prompt / Config / Linked Generations / Use
  Prompt, buttons Playground and "Run experiment", and a list of detected variables
  (scope, rate_card, received, request).
- LangSmith prompt page (`screenshots/07-langsmith-prompt-page.jpg`): "Environments" panel with
  **Production** (our `production` tag became this) and **Staging** ("Nothing promoted yet"),
  commit history, buttons "Commit tag" and "Promote", and a Code Snippet section. Mustache
  variables are highlighted.

## Step 3 — Dataset (10:13)

| | Command | Wall time | Calls |
|---|---|---|---|
| Langfuse | `langfuse_leg.py push-dataset` | 7.3 s | `create_dataset` + 30 × `create_dataset_item` (one per item; no bulk call in the SDK) |
| LangSmith | `langsmith_leg.py push-dataset` | 2.2 s | `create_dataset` + 1 × `create_examples` (bulk) |

Records: `records/08-*-push-dataset.txt`. Both keep `message_id` as item metadata. Langfuse
items got ids `scope-check-msg-NN` (we set them, so a re-run upserts). Screenshots:
`screenshots/08-langfuse-dataset-items.jpg`, `screenshots/10-langsmith-dataset-examples.jpg`
(LangSmith also shows a "Splits" column, all `base`).

## Step 4 — Experiment v1 (started 10:13:21, both at once, concurrency 4 each)

### LangSmith

`langsmith_leg.py experiment --tag production --name v1` → experiment `v1-a7184457`, **94.3 s
wall** for 30 examples with 3 evaluators, no errors. The dataset page showed live progress
("7 / 30 runs") with per-evaluator averages while it ran
(`screenshots/09-langsmith-dataset-experiment-live-progress.jpg`). Export:
`python/export_langsmith_experiment.py v1-a7184457 records/10-langsmith-experiment-v1-results.json`.

- items_exact **26/30**, total_exact **29/30**, reply_judge **27/30**.
- p50 latency 10.7 s, p99 18.0 s, 45,525 tokens, total_cost 0 (no price for glm-5.3).

### Langfuse — first attempt with a sync task

`langfuse_leg.py experiment --label production --name v1` with `def task(*, item, **kwargs)`
(the sync form Langfuse's own docstring shows, `experiment.py:641`). After 3.5 min only 10
traces existed. Source: `client.py:3049` awaits `_run_task(task, item)`, and `_run_task`
(`experiment.py:1024-1029`) calls `task(item=item)` directly and only awaits the result if it
is a coroutine. A sync task therefore blocks the event loop, so items run **one at a time** even
with `max_concurrency=4` (the semaphore at `client.py:2812` only limits async tasks).
LangSmith's `evaluate` runs a sync target in a thread pool, so it was concurrent.

LangSmith experiment table: `screenshots/11-langsmith-experiment-v1-table.jpg` (one row per
example, evaluator columns colored green/red, averages in the header: items 0.88, judge 0.88,
total 0.96, p50 latency 10.70 s). The header also shows a GitHub badge "agenti…/5a7c52": the
SDK recorded the local git repo and commit on its own. (Our dev repo name shows; crop it in public
screenshots.)

### LangSmith v1 failures (real, not staged)

| msg | failed | what happened |
|---|---|---|
| msg-04 | judge | items and total right. Judge: "cites only clause S7 and never addresses the second expected clause S3". **Judge error**: `clauses` lists acceptable alternatives, the judge read it as "all required". |
| msg-05 | items | "Workshops page and a Retreats page" extracted as two requests, each extra_page × 1. Label expects one item × 2. Total 360 correct. |
| msg-15 | items, total, judge | "connect it to our Instagram ads" classified as a second `analytics_setup` → $240 instead of $120 (label: needs_estimate). |
| msg-21 | items | "send a copy to the person who wrote in" classified in_scope S3 ("a minor behavior of that same form"); label: needs_estimate. |
| msg-24 | items, judge | sitemap and page titles for the new domain split into two in_scope items (label: one). Judge said the page titles were "out-of-scope work … provided at no cost" — follows from the label having one item. |

## Step 5 — Human review (annotation queues)

### LangSmith (10:19)

`langsmith_leg.py queue --experiment v1-a7184457` → queue `40edb6cc-86d6-4003-be69-6dacd08ce343`,
30 runs, 3.5 s (`records/11-langsmith-queue-v1.txt`).

- **Rubric item dropped without an error.** `create_annotation_queue(rubric_items=[{"feedback_key":
  "human_reply_ok", …}])` succeeded, but `read_annotation_queue` and the UI showed no rubric. The
  key must exist as a feedback config first. After `create_feedback_config("human_reply_ok",
  categorical send-as-is=1 / needs-a-fix=0)` and `update_annotation_queue(..., rubric_items=…)`,
  the GET returned the rubric with its `feedback_config_id`
  (`records/11-langsmith-queue-rubric-retry.txt`). `queue()` in `langsmith_leg.py` now creates the
  config first.
- Queue UI (`screenshots/12-langsmith-annotation-queue-item.jpg`): left list labelled only
  "Run 01a14321…" (no message text), center shows inputs and outputs as editable fields (each
  with a delete icon, "Add Field", "Add Item"), right shows the existing evaluator feedback,
  "Assertions", "Reviewer Note", and buttons "Add to Dataset (D)", "Requeue at End (E)",
  "Next (⌘↵)".

## Step 6 — Prompt v2 (10:20)

Written from the v1 failures above, before seeing Langfuse's v1 results. Only `scope-extract` and
`scope-classify` change; `scope-reply` and `scope-judge` stay at v1 so the score is measured the
same way before and after.

- `scope-extract.v2`: one request per kind of work, with a count ("Add three pages: Events, FAQ
  and Careers"); changes to the same included feature are one request.
- `scope-classify.v2`: three rules — a clause covers only what it says (new behaviour on an
  included feature is extra work); use a rate-card item only when its label describes the
  request itself (connecting to another service is needs_estimate); quantity is in the item's
  unit.
- The first draft quoted two dataset messages as examples (contact-form copy, sitemap + titles).
  Replaced with examples that are not in the dataset (photo gallery uploads, menu colour + font)
  so v2 does not learn the test answers.

Pushed with label/tag `candidate`, only these two prompts:

| | Wall time | Result |
|---|---|---|
| Langfuse `push-prompts --version 2 --label candidate --names …` | 1.7 s | version 2, labels ['candidate', 'latest'] |
| LangSmith `langsmith_push_prompts.py --version 2 --tag candidate --names …` | 3.5 s | commits 0738832e, 586b51ca |

**Default fetch after a new version** (`records/12-*-after-v2.txt`):

| Call | Returns |
|---|---|
| Langfuse `get_prompt("scope-extract")` (no label) | version 1 (= production) |
| Langfuse `label="latest"` | version 2 |
| LangSmith `pull_prompt_commit("scope-extract")` (no tag) | **v2** (newest commit) |
| LangSmith `"scope-extract:production"` | v1 |

So code that does not pin a tag gets an unreviewed draft on LangSmith, and production on
Langfuse.

Screenshots: `screenshots/13-langsmith-prompt-v2-candidate.jpg` (commit history with the
`candidate` tag; Environments still Production = v1), `screenshots/14-langfuse-prompt-v2-candidate.jpg`.

### Langfuse v1 results (both runs)

| Run | Task | Wall | items_exact | total_exact | reply_judge | trace latency p50 | Records |
|---|---|---|---|---|---|---|---|
| `v1` (started 10:13:21, alongside LangSmith v1) | sync `def` (one at a time) | **472.1 s** | 24/30 | 30/30 | 27/30 | 50.7 s | `records/09-langfuse-experiment-v1-sync.txt`, `records/10-langfuse-experiment-v1-results.json` |
| `v1-async` (10:22, alone) | `async def` + `asyncio.to_thread` | **140.7 s** | 24/30 | 29/30 | 28/30 | — | `records/09-langfuse-experiment-v1-async.txt`, `records/10-langfuse-experiment-v1-async-results.json` |

- The sync run's per-trace latency (p50 50.7 s vs ~10 s) includes waiting for the blocked event
  loop, so trace latency in the UI is wrong for sync tasks, not just wall time.
- `run_experiment` prints a summary with average scores and a link to the dataset run; it hides
  per-item results unless `include_item_results=True`.
- Exporting a run took ~8 min: 30 × `trace.get` + `datasets.get_run` + `dataset_items.list` hit
  the Hobby plan's General API limit (30 req/min); the SDK retried without erroring.
- `v1-async` failures (different from LangSmith's because the model is not deterministic): msg-03
  ("book and pay" split into booking + payments, both priced as `online_booking_payments` →
  $2,800 instead of $1,400), msg-05 and msg-20 (split into per-page / per-language items, total
  right), msg-11 (clause S1 instead of S5/S7), msg-21 (copy-to-sender in_scope S3), msg-24 (split
  into three items, one an invented "domain move" needs_estimate).

## Step 5 — Human review, both platforms (10:29–10:46)

Reviewed by the agent in the browser, all 30 items on each platform, reading the message, the
items and the full reply before choosing. Same rubric on both: "Would you send this reply to the
client as is?"

### LangSmith — queue `review-v1-a7184457` (experiment v1-a7184457)

- Verdict buttons "send as is" / "needs a fix" (from the categorical feedback config). Clicks per
  item: 1 verdict + 1 "Next" = 2; a note adds a click + typing.
- After choosing "needs a fix" on msg-15 the queue jumped to the next item without "Next" and
  left msg-15 in "Needs Review" (its verdict was saved). It came back at the end and needed
  "Done". After that, every verdict click was followed by a check that the item had not moved.
- Notes typed into "Reviewer Note" are saved as a separate feedback with key `note`. One note
  got five stray characters ("openi") appended while typing (likely another browser extension's
  key handling); removed before saving.
- "Add to Dataset" opens a dataset picker and adds the run as a **new** example (inputs/outputs
  editable in the queue first). Not used: the dataset already holds the correct labels, and a
  31st item would break the shared 30-item set
  (`screenshots/16-langsmith-queue-add-to-dataset.jpg`).
- Result (`records/14-langsmith-human-review-v1.txt`, all feedback in
  `records/14-langsmith-feedback-all-v1.json`): **27 send as is, 3 needs a fix**.

| msg | human | items | total | judge | note |
|---|---|---|---|---|---|
| msg-04 | send | ✓ | ✓ | ✗ | judge read the acceptable clause list as "both required" |
| msg-05 | send | ✗ | ✓ | ✓ | label groups both pages into one item × 2 |
| msg-15 | **fix** | ✗ | ✗ | ✗ | Instagram-ads link priced as analytics; $240 not $120 |
| msg-21 | **fix** | ✗ | ✓ | ✓ | copy-to-sender given free; **judge passed it** |
| msg-24 | **fix** | ✗ | ✓ | ✗ | calls S5 "the 30-day bug-fix window" (that is S7) |

Minor flaws seen but sent: msg-17 mentions "the existing website's booking system" (there is
none).

### Langfuse — queue `review-v1-async` (run v1-async), `cmvaje2z101rcad0jjqcpdpa5`

- `langfuse_leg.py queue --run v1-async`: creates a BOOLEAN score config `human_reply_ok`, a queue
  with it, and 30 TRACE items; 8.0 s (`records/11-langfuse-queue-v1.txt`). No silent drop: the
  queue requires `score_config_ids` up front.
- Queue list shows item id, type, source trace id, status — no message text
  (`screenshots/18-langfuse-annotation-queue-list.jpg`). "Process queue" opens a review view
  with input, output and reply rendered as readable text; True/False buttons (hotkeys 1/2), a
  comment bubble per score, "Mark Completed (Ctrl+Enter)" which completes and opens the next.
  Automatic scores are hidden in this view. Clicks per item: verdict + Mark Completed = 2.
- Score comments: bubble → text → "Save Changes" (3 extra actions).
- **"Correct output"** under the output opens an editor pre-filled with the full output JSON;
  replacing it with text saves a score named `output` of type `CORRECTION` on the trace
  (`screenshots/21-langfuse-queue-corrected-output.jpg`). Used once, on msg-03. The first typing
  attempt did nothing because the editor wasn't focused.
- Result (`records/14-langfuse-human-review-v1.txt`, `records/14-langfuse-annotation-scores-v1.json`):
  **28 True, 2 False**, queue status 30 × COMPLETED.

| msg | human | items | total | judge | note |
|---|---|---|---|---|---|
| msg-03 | **False** | ✗ | ✗ | ✗ | booking and payments counted twice; correction saved |
| msg-05 | True | ✗ | ✓ | ✓ | split pages, total right |
| msg-11 | True | ✗ | ✓ | ✓ | cites S1; reply also names S5 |
| msg-20 | True | ✗ | ✓ | ✓ | languages split, total right |
| msg-21 | **False** | ✗ | ✓ | ✗ | copy-to-sender given free; "Hi [Client]" |
| msg-24 | True | ✗ | ✓ | ✓ | adds an unrequested domain-move estimate, as a question |

### What human review found across both

- `items_exact` is stricter than a person: 5 of its 10 failures (LangSmith 1 of 4, Langfuse 4 of
  6) were replies a person would send, mostly because the labels group same-kind work into one
  item with a quantity.
- `total_exact` matched the human on every money error.
- The judge missed msg-21 on LangSmith (gave away work, judged PASS) and failed msg-04 wrongly.

## Step 7 — Experiment v2

### First attempt (10:29, both at once, concurrency 4 each) — rate-limited, kept as a record

Commands: `langfuse_leg.py experiment --label candidate --only scope-extract,scope-classify --name v2`
and `langsmith_leg.py experiment --tag candidate --only scope-extract,scope-classify --name v2`.
`--only` sends those two prompts to the `candidate` version and keeps reply and judge on
`production` (v1).

z.ai answered some calls with `429 {'code': '1302', 'message': 'Rate limit reached for
requests'}` even after the OpenAI client's 5 retries (8 calls in flight across two runs plus the
judges). Wall: Langfuse 161.3 s, LangSmith 149.9 s (`records/13-*-experiment-v2.txt`).

How each SDK and UI reports a run whose task raised:

- **LangSmith** (`records/15-langsmith-experiment-v2-results.json`): 6 runs errored (msg-07, 12,
  22, 23, 25, 30). The evaluators still ran on them and each wrote a feedback with score `None`
  and comment `KeyError('items')` etc. `feedback_stats` averages only the scored ones (items
  0.958, judge 1.0) and keeps an `errors` count (6, judge 8). The experiments list shows the
  average with a red error badge, e.g. "0.96 ⓘ 20%", "1.00 ⓘ 27%"
  (`screenshots/23-langsmith-experiments-list-v2-errors.jpg`). Same screenshot: v1 now shows a
  `human_reply_ok` column "send as is 27 · 90%".
- **Langfuse** (`records/13-langfuse-experiment-v2.txt`): the SDK logged `Item N failed: Error code:
  429 …` for 5 items and printed averages over the rest (items 0.960, total 1.000, judge 1.000)
  with no failure count in the summary. Opening the dataset run link lands on the Experiments
  compare view with v2 as baseline and v1-async auto-added as comparison: per-score averages,
  delta, and up/down counts (e.g. items_exact 1.00 vs 0.80, "↗0 ↘4"); the summary covers "this
  page (20 items)" only (`screenshots/24-langfuse-compare-v2-vs-v1-async-ratelimited.jpg`).

Both v2 results are discarded for scoring. Rerun below: one platform at a time, concurrency 2.

### Model prices added on both platforms (10:47–10:54)

Neither platform priced our calls, so every trace showed cost 0 / None. Both now have a price
for `glm-5.3` at z.ai's public rate (input $1.40, cached input $0.26, output $4.40 per 1M).
Prices apply to traces ingested after the rule exists; earlier runs stay unpriced.

- **Langfuse** (`records/18-langfuse-model-definition-glm-5.3.txt`,
  `screenshots/25-langfuse-create-model-glm-5.3.jpg`): none of its 190 built-in models matches
  GLM (`records/17-…`). Project Settings → Model Definitions → Add Model Definition. Name
  `glm-5.3`, match `(?i)^(glm-5\.3)$`, prices per token: `input` 0.0000014, `output` 0.0000044,
  `input_cached_tokens` 0.00000026 (one "Add Price" click for the third row). Prices are typed
  per token; a preview shows per 1K and per 1M. 5 clicks, 7 fields.
- **LangSmith** (`records/19-langsmith-price-map-glm-check.txt`,
  `screenshots/26-langsmith-add-model-price-glm-5.3.jpg`): 997 built-in rules, and one does
  match `^glm\-5\.3$`, but it is pinned to provider `azure`. `wrap_openai` records
  `ls_provider=openai`, so no rule applied. Settings → Model pricing → + Model. Name
  `zai-glm-5.3`, input 1.40 per 1M with breakdown `cache_read` 0.26, output 4.40, match
  `^glm\-5\.3$`, provider `openai`. Trap: the Match Pattern field auto-fills from the model name
  and typing appends to it, so select all first. 5 clicks, 7 fields.

### Rerun (10:48, one platform at a time, concurrency 2) — the scored v2

Same commands with `--name v2-rerun --concurrency 2`. Background shell log in
`records/16-langsmith-experiment-v2-rerun.txt` and `records/16-langfuse-experiment-v2-rerun.txt`.

**LangSmith `v2-rerun-1a2d3e87`**: 0 errors, wall 209.6 s at concurrency 2
(`records/16-langsmith-experiment-v2-rerun-results.json`, `…-export.txt`).

| Score | v1 | v2-rerun | Fixed by v2 | Broken by v2 |
|---|---|---|---|---|
| items_exact | 26/30 | 26/30 | msg-15, msg-21 | msg-22, msg-27 |
| total_exact | 29/30 | 30/30 | msg-15 | — |
| reply_judge | 27/30 | 28/30 | msg-04, msg-15 | msg-09 |

From `python/diff_runs.py records/10-langsmith-experiment-v1-results.json
records/16-langsmith-experiment-v2-rerun-results.json` (`records/16-langsmith-v1-vs-v2-rerun-diff.txt`).
msg-15 (analytics + connect to Instagram ads) and msg-21 (the gallery-upload clause) are the two
cases the v2 rules were written for. msg-22 ("make everything faster") and msg-27 (map stopped
loading) are new item misses.

### Finding the changed messages in the UI — LangSmith (10:55)

Dataset page → tick v2-rerun → tick v1 → "Compare" in the bottom bar → click the "↓2" counter in
a score column. **4 clicks** from the dataset page to a table holding only the rows that changed
in one direction.

- The comparison takes the first ticked experiment as baseline (A); B columns show ↑/↓ counts
  relative to A and colour the cells that got worse red. A "Set baseline" button sits on each
  row of the experiments list.
- Clicking "↓2" under items_exact B filtered the table to msg-15 and msg-21 (v1 worse than v2).
- Screenshots: `27-langsmith-select-two-experiments.jpg`, `28-langsmith-compare-v2rerun-vs-v1.jpg`,
  `29-langsmith-compare-filter-regressions.jpg`. The Cost chart shows $0.00 for both, since both
  ran before the price rule.

## Step 8 — Promote v2 to production, then roll back (10:55–11:04)

The app code did not change. Both legs fetch prompts by `production` every run.

### LangSmith

Prompt page (opens on the newest commit) → "Promote" → "Promote to Production" → confirm
dialog "Promote to Production". **3 clicks per prompt** once on the page. The dialog shows
commit → environment and says "Changes may take a few minutes to propagate due to client
caching". The Production card then shows the new hash, and a toast says "Deployed to production".
Screenshots `30-` to `33-`.

`langsmith_leg.py run --id msg-15` right after (`records/20-langsmith-promote-v2-run.txt`):
the LLM runs carry `lc_hub_commit_hash` 0738832e (extract v2) and 586b51ca (classify v2), and
scope-reply stayed on ac945905 (v1). msg-15 now splits into "Add Google Analytics" (out_of_scope,
$120) and "Connect … to Instagram ads" (needs_estimate). Costs now show on the LLM runs
(e.g. classify $0.00052848) because of the price rule added before.

Rollback: the Production card's ↶ "Rollback" icon opens "Rollback history" (each hash the
environment has pointed to, with time and user). Picking a row opens the same "Promote to
Production" dialog → confirm. **3 clicks per prompt.** Quirk seen twice: the first click on a
history row only navigated to that commit's URL and the popover closed; opening Rollback again
from the commit URL and clicking the row opened the dialog. Screenshots `34-` to `36-`.
Verified with `pull_prompt_commit(…, skip_cache=True)`: extract fd054f80, classify fb633e6c (v1).

### Langfuse

Prompt page (opens on the newest version) → "+ Add label" → tick "production" under "Promote to
production?" → "Save". **3 clicks per prompt, no confirm dialog.** The production badge moves to
v2 at once. Screenshots `37-` to `39-`.

`langfuse_leg.py run --id msg-15` (`records/21-langfuse-promote-v2-run.txt`): generations link to
scope-extract v2, scope-classify v2 (×2), scope-reply v1. Same split of msg-15 as LangSmith,
total $120. Trace cost $0.00233752 over 10 observations; Langfuse splits usage into `input`
(uncached), `input_cached_tokens` and `output`, and prices each with the model definition (e.g.
classify: 62 × 1.40 + 768 × 0.26 + 63 × 4.40 per 1M = $0.00056368).

Rollback: select v1 in the version list → "+ Add label" → tick production → Save. **4 clicks per
prompt** (one more to select the old version). There is no rollback history view; the version
list shows only the current label positions. Screenshots `40-` to `42-`. Verified: all four
prompts' production = version 1.

### Client-side prompt caching (read from the installed SDK source)

- Langfuse 4.14.1: `langfuse/_utils/prompt_cache.py` `DEFAULT_PROMPT_CACHE_TTL_SECONDS = 60`
  (env `LANGFUSE_PROMPT_CACHE_DEFAULT_TTL_SECONDS`), per call `cache_ttl_seconds=`; a stale entry
  is served while it refreshes in the background.
- LangSmith 0.10.10: `langsmith/prompt_cache.py` `DEFAULT_PROMPT_CACHE_TTL_SECONDS = 5 * 60`,
  global singleton cache with background refresh; `Client(disable_prompt_cache=True)` or
  `pull_prompt_commit(…, skip_cache=True)` bypass it.
- So a long-running app sees a promotion within about 1 minute on Langfuse and about 5 minutes on
  LangSmith by default. Our CLI runs are fresh processes, so they saw it at once.

## Step 7 (continued) — Langfuse v2-rerun and its comparison view (11:05)

**Langfuse `v2-rerun`**: 0 errors, wall 233.5 s at concurrency 2, p50 13.3 s, max 35.3 s
(`records/16-langfuse-experiment-v2-rerun.txt`, `…-results.json`, `…-export.txt`). This run
started after the glm-5.3 model definition, so it is the first one with a cost: $0.060724 for
30 task traces (about $0.002 a message; judge calls not included).

| Score | v1-async | v2-rerun | Fixed by v2 | Broken by v2 |
|---|---|---|---|---|
| items_exact | 24/30 | 28/30 | msg-03, msg-05, msg-11, msg-20 | — |
| total_exact | 29/30 | 29/30 | msg-03 | msg-21 |
| reply_judge | 28/30 | 27/30 | msg-03 | msg-09, msg-24 |

(`records/16-langfuse-v1-async-vs-v2-rerun-diff.txt`.) Same prompts and model as LangSmith, but
the per-message flips differ between the two platforms' runs: GLM-5.3 is not deterministic at
these settings, so a single 30-message run moves by a few items either way. Both runs agree
that v2 lifts items_exact or leaves it level, and neither shows a clear regression.

Combined across both platforms (60 runs per version): items_exact v1 50 → v2 54, total_exact
58 → 59, reply_judge 55 → 55.

### Finding the changed messages in the UI — Langfuse

Datasets → scope-check (opens on **Items**) → **Experiments** tab → tick v2-rerun → tick
v1-async → "Compare". **4 clicks** from the dataset page to the comparison (one more than
LangSmith's because the dataset opens on Items). The SDK's printed "Dataset Run" link also
lands in this view with the newest run as baseline.

- The view shows a per-score summary with delta and ↗/↘ counts ("items_exact 1.00 vs 0.80,
  −0.20, ↗0 ↘4"), and each row shows both runs' scores side by side with a red −1.00 delta on
  changed cells.
- The ↗/↘ counters are not clickable, and the sidebar score filters (Numeric/Boolean Scores)
  filter by one run's score value, not by the change. There is no "show only changed rows"
  filter, so finding the 4 changed messages means scrolling 30 rows over **2 pages of 20**.
- The summary says "this page (20 items)": the averages and counts cover the visible page only.
- The experiments list has an "Error Count" column (v2 first attempt shows 5 in red) and a
  "Total Cost" column ("not recorded" for runs before the price existed).

Screenshots: `43-langfuse-dataset-experiments-list.jpg`, `44-langfuse-select-two-runs.jpg`,
`45-langfuse-compare-v2rerun-vs-v1async.jpg`.

## Step 9 — Live traffic and monitoring (11:03–11:13, then dashboards ~11:25)

`langsmith_leg.py live` and `langfuse_leg.py live` ran side by side, each sending the 30
messages one after another with `production` = v1 (`records/22-*-live.txt`). Both took about
9 min 20 s. Both price rules were in place, so every trace has a cost.

| | LangSmith | Langfuse |
|---|---|---|
| Traces | 30 | 30 |
| Latency p50 / p95 / max (s) | 16.89 / 29.94 / 48.29 | 16.84 / 31.55 / 47.58 |
| Cost per trace, mean | $0.001795 | $0.001580 |
| Cost, 30 traces | $0.053835 | $0.047386 |
| Source | `records/24-langsmith-live-stats.txt` | `records/24-langfuse-live-stats.txt` |

Latency is the model's (the same z.ai endpoint for both). The cost gap comes from token counts
in two separate sets of model calls, not from the prices: both use $1.40 / $0.26 / $4.40 per 1M,
and LangSmith's run stats split the same way (cache_read 31,168 tokens priced at $0.00810368).

Units per Langfuse trace: live traces have 8.67 observations on average (min 8, max 12), so
**9.67 billable units per trace**. Experiment traces are heavier: 15.6 observations (the
evaluators and the experiment span are observations) plus 3 scores = 19.6 units
(`records/23-langfuse-units-per-trace-v2-rerun.txt`).

Dashboards, both built in with no setup:

- **Langfuse** Home (`46-`, `47-`): traces by name, model costs by model ($0.11, 284.41K tokens on
  glm-5.3), score averages with 0/1 counts, observations over time, cost by model/type, and
  latency percentile tables (p50/p90/p95/p99) per trace name, per generation and per
  observation. Custom dashboards live under Dashboards.
- **LangSmith** project → Dashboard (`records/25-langsmith-monitoring-dashboard-panels.txt`):
  trace count, latency P50/P99, error rate, LLM calls, cost per trace P50/P99, tokens, per-tool
  and per-step (depth=1) counts and latency, feedback scores. The trace table (`48-`) shows
  latency and cost per trace inline. Screenshots of the dashboard timed out in the extension.

## Step 10 — Price of 100,000 traces a month for 3 people (11:20)

Full detail in `records/90-pricing-2026-10-16.md`.

| | LangSmith Plus | Langfuse Core |
|---|---|---|
| Monthly price | **$567** | **$98.36** (no scores) to **$119.69** (3 scores per trace) |
| Billed per | trace | trace + observation + score (9.67 units per trace measured) |
| Retention | 14 days base; 180 days extra fee | 90 days |
| Seats | $39 each | unlimited |
