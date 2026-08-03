---
sidebar_position: 8
title: "Experiments & Runs"
description: "Sweep a dataset across prompt versions and models, then read back per-cell results and reports."
---

# Experiments & Runs API (Phase 5 E3)

All endpoints verified working via curl against a real dev server (real
Postgres, a real BullMQ worker process — `apps/worker` — consuming a real
local Redis, and a real OpenAI account behind the gateway connection — no
mocked `fetch`, no mocked queue). Document updated only after curl
confirmation, per CLAUDE.md's API-reference rule.

An **experiment** ties a dataset (examples to evaluate against) to a
(prompt-version × model) grid to sweep. Starting a **run** freezes the
dataset's examples into `exampleSnapshot`, resolves the full grid — including
an automatic `production`-alias baseline cell per model, added whenever the
experiment names a `promptId` and that prompt's current production version
isn't already an explicit `version_ids` entry — and enqueues a BullMQ Flow
(one `finalize` job with one `cell` job per grid × example pair). Each `cell`
job renders the prompt version against the example's `input` variables and
calls the gateway **in-process** (`GatewayService.complete`), so budgets, rate
limits, and the cost ledger apply exactly like live traffic. The `finalize`
job (a BullMQ Flow parent) only runs once every child cell has settled, and
marks the run `succeeded` or `failed`.

Auth: `requireAnyAuth` (session cookie or personal/team API key) on every
route, no role restriction. Team-scoped throughout.

Verified with `apps/api` running via `npm run dev` and a real, separately
booted `apps/worker` process (`node dist/index.js`), both pointed at the same
Redis instance so the API's enqueued jobs are actually picked up by the
worker — not an in-process/inline stub.

---

### POST /api/v1/experiments

Creates an experiment: a dataset to evaluate, an optional prompt under test
(enables the automatic production-baseline cell), and the explicit
(version × model) grid to sweep. `version_ids` and `models` must each have
at least one entry.

```bash
curl -X POST $ACRUXCORE_BASE_URL/experiments \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dataset_id": "4595c340-d7fa-4d76-977e-76b60ebefb62", "prompt_id": "173ad5cd-969c-4a04-8896-fbf625bbc2e5", "name": "E3 Task7 greeting sweep", "version_ids": ["b5327b3e-3c45-4858-ac62-1e5852279624"], "models": ["gpt-4o-mini-e3t7"]}'
```

Response (status 201) — `runs` is empty right after creation:

```json
{
  "id": "9462c9b7-62a7-4f01-80fe-71f142cdd02b",
  "teamId": "c2e28d00-c7ed-4c27-85d9-434927282f67",
  "datasetId": "4595c340-d7fa-4d76-977e-76b60ebefb62",
  "promptId": "173ad5cd-969c-4a04-8896-fbf625bbc2e5",
  "name": "E3 Task7 greeting sweep",
  "config": { "models": ["gpt-4o-mini-e3t7"], "versionIds": ["b5327b3e-3c45-4858-ac62-1e5852279624"] },
  "createdBy": "6937e9cb-6754-4f45-aac8-a780d2e3ef57",
  "createdAt": "2026-07-07T14:26:50.940Z",
  "runs": []
}
```

#### Error responses

Missing `version_ids` (status 400):

```bash
curl -X POST $ACRUXCORE_BASE_URL/experiments \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dataset_id": "4595c340-d7fa-4d76-977e-76b60ebefb62", "models": ["gpt-4o-mini-e3t7"]}'
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Required" } }
```

---

### POST /api/v1/experiments/:id/runs

Starts a run: freezes the dataset's current examples, resolves the grid
(here: the explicit v2 cell + an automatic production-baseline cell, since
production still pointed at v1 — not among the explicit version_ids), and
enqueues a BullMQ Flow. Returns immediately — the actual gateway calls
happen asynchronously in the worker process.

```bash
curl -X POST $ACRUXCORE_BASE_URL/experiments/9462c9b7-62a7-4f01-80fe-71f142cdd02b/runs \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 202):

```json
{ "run_id": "891710e4-1ac4-4bb7-b618-0f81e31aa291", "status": "queued" }
```

#### Error responses

Nonexistent experiment id (status 404):

```bash
curl -X POST $ACRUXCORE_BASE_URL/experiments/00000000-0000-0000-0000-000000000000/runs \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Experiment not found." } }
```

---

### GET /api/v1/runs/:id

Polled immediately after starting the run above — the real worker had not
yet picked up any of the 4 cell jobs (2 grid cells × 2 dataset examples):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/runs/891710e4-1ac4-4bb7-b618-0f81e31aa291
```

Response (status 200) — in-flight, `queued`, zero results so far:

```json
{
  "id": "891710e4-1ac4-4bb7-b618-0f81e31aa291",
  "experimentId": "9462c9b7-62a7-4f01-80fe-71f142cdd02b",
  "status": "queued",
  "startedAt": null,
  "endedAt": null,
  "error": null,
  "createdAt": "2026-07-07T14:27:16.920Z",
  "grid": [
    { "model": "gpt-4o-mini-e3t7", "cellKey": "v2|gpt-4o-mini-e3t7", "variantKind": "version", "variantLabel": "v2", "promptVersionId": "b5327b3e-3c45-4858-ac62-1e5852279624", "isProductionBaseline": false },
    { "model": "gpt-4o-mini-e3t7", "cellKey": "production|gpt-4o-mini-e3t7", "variantKind": "version", "variantLabel": "production", "promptVersionId": "8250ce7b-cc5f-463b-83be-3a497f3f6f0a", "isProductionBaseline": true }
  ],
  "exampleCount": 2,
  "results": { "total": 0, "succeeded": 0, "errored": 0 }
}
```

Polled again ~2 seconds later, same run id — the real worker process had by
then dequeued and processed all 4 cell jobs (2 grid cells x 2 examples)
against the real OpenAI account, and the finalize job marked it succeeded:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/runs/891710e4-1ac4-4bb7-b618-0f81e31aa291
```

Response (status 200) — succeeded, all 4 results in:

```json
{
  "id": "891710e4-1ac4-4bb7-b618-0f81e31aa291",
  "experimentId": "9462c9b7-62a7-4f01-80fe-71f142cdd02b",
  "status": "succeeded",
  "startedAt": null,
  "endedAt": "2026-07-07T14:27:18.799Z",
  "error": null,
  "createdAt": "2026-07-07T14:27:16.920Z",
  "grid": [
    { "model": "gpt-4o-mini-e3t7", "cellKey": "v2|gpt-4o-mini-e3t7", "variantKind": "version", "variantLabel": "v2", "promptVersionId": "b5327b3e-3c45-4858-ac62-1e5852279624", "isProductionBaseline": false },
    { "model": "gpt-4o-mini-e3t7", "cellKey": "production|gpt-4o-mini-e3t7", "variantKind": "version", "variantLabel": "production", "promptVersionId": "8250ce7b-cc5f-463b-83be-3a497f3f6f0a", "isProductionBaseline": true }
  ],
  "exampleCount": 2,
  "results": { "total": 4, "succeeded": 4, "errored": 0 }
}
```

Note: `startedAt` stayed null through this observed run — the run engine
does not appear to stamp it on transition to `succeeded` in this build; only
`endedAt` is populated. Documented as observed, not as a defect judgment.

Drift note (re-verified 2026-07-12): `isProductionBaseline` on each grid
entry above was missing from this doc's original example even though the
live server includes it for runs started via `POST /experiments/:id/runs`
— added back here to match observed behavior. By contrast, a run started
via the optimize loop (`POST /prompts/:promptId/optimize`, documented in
optimize.md) does NOT include `isProductionBaseline` on its `grid` entries
(only `GET /runs/:id/report`'s `variants`/`cells` carry that field for an
optimize-originated run) — a real, observed difference between the two
run-creation code paths, not a doc error.

Each of the 4 result rows landed in `eval_results` with real, distinct model
output and its own real gateway `trace_id` (verified via a read-only SELECT,
not part of the HTTP surface but confirming the worker really called the
gateway rather than stubbing it):

```text
v2 / Alice          -> "Hey Alice! 🌟 It's a fantastic day and I'm so excited to see you shine! 🎉"
v2 / Bob            -> "Hey there, Bob! 🎉 Get ready to seize the day and make it amazing!"
production / Alice  -> "Hello, Alice! It's wonderful to see you!"
production / Bob    -> "Hello, Bob! It's great to see you!"
```

#### Error responses

Nonexistent run id (status 404):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/runs/00000000-0000-0000-0000-000000000000
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Run not found." } }
```

---

### GET /api/v1/runs/:id/report

Comparison report (Phase 5 E5): the full (variant x model) matrix with
per-cell averages, each non-baseline cell's regression delta vs. the
same-model production-baseline cell, a leaderboard, and an advisory
winner. Computed on read from the run's `eval_result` rows — no dedicated
report table. Verified against a fresh experiment (prompt "support-reply",
v1 promoted to `production` with a vague, unconstrained system message;
v2 an explicit "reply in exactly two sentences, no exclamation marks"
instruction), run against 2 dataset examples whose `criteria` both demand
the same strict two-sentence format — arranged specifically so v2 and
production diverge sharply on the judge's score, rather than landing on a
`flat`/`unknown` delta that wouldn't demonstrate the feature.

Note: the judge model itself is a fixed `gpt-4o-mini` public name
(`JUDGE_MODEL` in `judge.service.ts`, overridable via `EVAL_JUDGE_MODEL`) —
distinct from whatever public model name(s) the experiment's grid sweeps.
It must be registered separately via `POST /gateway/models` (same as any
other model) or every judge call fails with `Model 'gpt-4o-mini' is not
registered.` (observed firsthand on a first attempt before registering it;
see the cell drill-down section below for that raw error text).

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/runs/6e8bcaaf-8b5b-40f5-9b59-6d83eec71596/report
```

Response (status 200) — v2 clearly beats the production baseline: avgScore
85 vs 20, passRate 1 vs 0, deltaVsBaseline.label "improved" (+65 score
points), and the winner is v2:

```json
{
  "runId": "6e8bcaaf-8b5b-40f5-9b59-6d83eec71596",
  "status": "succeeded",
  "models": ["gpt-4o-mini-e5t3"],
  "variants": [
    { "variantKind": "version", "promptVersionId": "3bbf603b-e99e-475a-adf6-ab9edcb0ecc0", "variantLabel": "v2", "isProductionBaseline": false },
    { "variantKind": "version", "promptVersionId": "2bd8f192-d4cf-4123-9816-4d8eba9158bb", "variantLabel": "production", "isProductionBaseline": true }
  ],
  "cells": [
    {
      "cellKey": "v2|gpt-4o-mini-e5t3",
      "variantLabel": "v2",
      "model": "gpt-4o-mini-e5t3",
      "isProductionBaseline": false,
      "avgScore": 85,
      "passRate": 1,
      "exampleCount": 2,
      "scoredCount": 2,
      "unscoredCount": 0,
      "deltaVsBaseline": { "score": 65, "passRate": 1, "label": "improved" }
    },
    {
      "cellKey": "production|gpt-4o-mini-e5t3",
      "variantLabel": "production",
      "model": "gpt-4o-mini-e5t3",
      "isProductionBaseline": true,
      "avgScore": 20,
      "passRate": 0,
      "exampleCount": 2,
      "scoredCount": 2,
      "unscoredCount": 0,
      "deltaVsBaseline": null
    }
  ],
  "leaderboard": ["v2|gpt-4o-mini-e5t3", "production|gpt-4o-mini-e5t3"],
  "winner": { "cellKey": "v2|gpt-4o-mini-e5t3", "variantLabel": "v2", "model": "gpt-4o-mini-e5t3", "avgScore": 85 }
}
```

#### Error responses

Nonexistent run id (status 404) — same message/code as `GET /runs/:id`:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/runs/00000000-0000-0000-0000-000000000000/report
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Run not found." } }
```

---

### GET /api/v1/runs/:id/cells/:cellKey

Drill-down (Phase 5 E5): one grid cell's per-example outputs, judge
reasoning, and traces. `cellKey` is `${variantLabel}|${model}` (as minted
into the run's `grid`) and must be URL-encoded (`|` -> `%7C`) — decoded
again by Express before it reaches the controller. Curled against the same
run as the report above, both of its two cells:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/runs/6e8bcaaf-8b5b-40f5-9b59-6d83eec71596/cells/v2%7Cgpt-4o-mini-e5t3"
```

Response (status 200) — v2's two examples: one perfect (score 100), one
partial-credit (score 70, missing the concrete next step) — both `passed`:

```json
{
  "cellKey": "v2|gpt-4o-mini-e5t3",
  "variantLabel": "v2",
  "model": "gpt-4o-mini-e5t3",
  "examples": [
    {
      "exampleId": "95f4e926-c036-4fa6-881a-4453b7c3d3fd",
      "input": { "complaint": "My package arrived three days late and the box was crushed." },
      "criteria": "Response must be EXACTLY two sentences: first sentence apologizes and names the specific issue (late delivery / crushed box), second sentence states one concrete next step (e.g. replacement or refund). No exclamation marks. No greeting or sign-off.",
      "output": "I apologize for the delay and the condition of your package. Please provide your order number so we can initiate a replacement or refund for you.",
      "score": 100,
      "passed": true,
      "reason": "The output consists of exactly two sentences: the first sentence apologizes for the delay and mentions the condition of the package, while the second sentence clearly states the next step of providing the order number for a replacement or refund.",
      "traceId": "04e58fce-3fd0-4488-907e-d0a79a7cc47d",
      "judgeTraceId": "2fd53824-36bd-48f9-9550-b9ba43ae1663"
    },
    {
      "exampleId": "e4db8a4f-f530-49ac-87e7-f4f208b2c19b",
      "input": { "complaint": "I was charged twice for the same order and nobody has responded to my emails." },
      "criteria": "Response must be EXACTLY two sentences: first sentence apologizes and names the specific issue (double charge / no response to emails), second sentence states one concrete next step (e.g. refund of duplicate charge). No exclamation marks. No greeting or sign-off.",
      "output": "I apologize for the inconvenience caused by the double charge and the lack of response to your emails. Please provide your order number so that I can investigate this issue further.",
      "score": 70,
      "passed": true,
      "reason": "The output contains an apology for the double charge and the lack of response to emails, fulfilling the first sentence requirement. However, it does not provide a concrete next step, which is necessary to fully meet the criteria.",
      "traceId": "2b8607f6-d7e8-43bb-92ff-3c105efb7ed4",
      "judgeTraceId": "db82535f-3c88-478f-8ff2-489a8c2e5bb8"
    }
  ]
}
```

The production-baseline cell, for contrast — both examples score 20,
`passed: false`, and the judge's reason names the exact violation (too many
sentences, greeting/sign-off present):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/runs/6e8bcaaf-8b5b-40f5-9b59-6d83eec71596/cells/production%7Cgpt-4o-mini-e5t3"
```

Response (status 200) — excerpted to one example (the other is the same shape):

```json
{
  "cellKey": "production|gpt-4o-mini-e5t3",
  "variantLabel": "production",
  "model": "gpt-4o-mini-e5t3",
  "examples": [
    {
      "exampleId": "e4db8a4f-f530-49ac-87e7-f4f208b2c19b",
      "input": { "complaint": "I was charged twice for the same order and nobody has responded to my emails." },
      "criteria": "Response must be EXACTLY two sentences: first sentence apologizes and names the specific issue (double charge / no response to emails), second sentence states one concrete next step (e.g. refund of duplicate charge). No exclamation marks. No greeting or sign-off.",
      "output": "I'm really sorry to hear about the double charge and the delay in getting a response. We certainly want to resolve this issue for you as quickly as possible. \n\nTo assist you better, could you please provide me with the following details? \n\n1. The order number.\n2. The date of the order.\n3. Any reference numbers or transaction details for both charges.\n\nOnce I have that information, I'll be able to look into it right away and help you sort this out. Thank you for your patience, and I appreciate your understanding!",
      "score": 20,
      "passed": false,
      "reason": "The output does not meet the requirement of being exactly two sentences; it contains multiple sentences and includes a greeting and sign-off, which are not allowed.",
      "traceId": "c43822d7-5562-405e-8fa0-02a7acb3995a",
      "judgeTraceId": "3e396879-160e-4f3d-9f05-95dde37ece79"
    }
  ]
}
```

#### Error responses

Nonexistent run id (status 404) — same message/code as `GET /runs/:id/report`:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/runs/00000000-0000-0000-0000-000000000000/cells/v2%7Cgpt-4o-mini-e5t3"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Run not found." } }
```

A `cellKey` that does not match any of the run's grid cells (status 200,
not an error) — the run itself is real, the cell key is simply not one of
its grid entries, so it returns gracefully with an empty `examples` array:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/runs/6e8bcaaf-8b5b-40f5-9b59-6d83eec71596/cells/nonexistent%7Cmodel-x"
```

```json
{ "cellKey": "nonexistent|model-x", "variantLabel": "nonexistent", "model": "model-x", "examples": [] }
```

---

### GET /api/v1/experiments

Lists the team's experiments. Note: unlike the JSDoc on `ExperimentDto`
(which says `runs` is "omitted (empty array) on list"), the list endpoint as
observed actually DOES populate `runs` per experiment (newest first) — this
doc reflects the real observed response, not the comment.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/experiments
```

Response (status 200) — abbreviated to one experiment with its 2 runs:

```json
{
  "data": [
    {
      "id": "9462c9b7-62a7-4f01-80fe-71f142cdd02b",
      "teamId": "c2e28d00-c7ed-4c27-85d9-434927282f67",
      "datasetId": "4595c340-d7fa-4d76-977e-76b60ebefb62",
      "promptId": "173ad5cd-969c-4a04-8896-fbf625bbc2e5",
      "name": "E3 Task7 greeting sweep",
      "config": { "models": ["gpt-4o-mini-e3t7"], "versionIds": ["b5327b3e-3c45-4858-ac62-1e5852279624"] },
      "createdBy": "6937e9cb-6754-4f45-aac8-a780d2e3ef57",
      "createdAt": "2026-07-07T14:26:50.940Z",
      "runs": [
        { "id": "891710e4-1ac4-4bb7-b618-0f81e31aa291", "experimentId": "9462c9b7-62a7-4f01-80fe-71f142cdd02b", "status": "succeeded", "startedAt": null, "endedAt": "2026-07-07T14:27:18.799Z", "error": null, "createdAt": "2026-07-07T14:27:16.920Z" },
        { "id": "0cb95fe0-5459-4287-a7b3-f8929ce3d0e1", "experimentId": "9462c9b7-62a7-4f01-80fe-71f142cdd02b", "status": "succeeded", "startedAt": null, "endedAt": "2026-07-07T14:26:59.929Z", "error": null, "createdAt": "2026-07-07T14:26:56.763Z" }
      ]
    }
  ]
}
```

---

### GET /api/v1/experiments/:id

Fetches one experiment with its runs (newest first).

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/experiments/9462c9b7-62a7-4f01-80fe-71f142cdd02b
```

Response (status 200) — same shape as the list entry above for this experiment.

#### Error responses

Nonexistent experiment id (status 404):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" $ACRUXCORE_BASE_URL/experiments/00000000-0000-0000-0000-000000000000
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Experiment not found." } }
```
