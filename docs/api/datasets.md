---
sidebar_position: 7
title: "Datasets"
description: "Create and manage example sets used by experiments, evaluations, and the optimize loop."
---

# Datasets API (Phase 5 E2)

All endpoints verified working via curl against a real dev server (real
Postgres, a real OpenAI account behind the gateway connection — no mocked
`fetch`). Document updated only after curl confirmation, per CLAUDE.md's
API-reference rule.

Datasets hold examples used later by the evaluation/experiment domains
(E3+): each example is an `input` (a variable bag to re-render against a
candidate prompt template) plus an optional `criteria` (the rubric a judge
checks against). Examples can be added manually (`POST /:id/examples`) or in
bulk by selecting existing trace feedback rows (`POST /from-feedback`) — the
latter only works for feedback whose source trace had **captured payloads**
(`x-capture-payloads: true` on the originating gateway call), since it reads
`span_payloads.variables`.

Auth: `requireAnyAuth` (session cookie or personal/team API key) on every
route, no role restriction. Team-scoped throughout — a dataset outside the
caller's team behaves as if it doesn't exist (404). `DELETE /:id` is a
soft-delete: the row is excluded from `GET /` (list) and `GET /:id` returns
404 for it afterwards, same as a truly missing id.

---

### POST /api/v1/datasets

Creates an empty dataset — no examples yet. `overall_feedback` is optional
(a dataset-level rubric applied on top of each example's own criteria).
Examples are added afterwards via `POST /:id/examples` or `POST /from-feedback`.

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "manual-review-set", "overall_feedback": "Keep responses concise and polite"}'
```

Response (status 201):

```json
{
  "id": "04f757bb-c9a5-4400-8958-018defbd2fa1",
  "teamId": "8385d37a-c015-4787-b3da-0bf64d2378f0",
  "name": "manual-review-set",
  "overallFeedback": "Keep responses concise and polite",
  "createdBy": "4949b28b-cace-488d-9369-cdedac4fa4a2",
  "createdAt": "2026-07-07T08:40:51.145Z",
  "updatedAt": "2026-07-07T08:40:51.145Z",
  "exampleCount": 0
}
```

#### Error responses

Missing `name` (status 400):

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"overall_feedback": "no name provided"}'
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Required" } }
```

---

### POST /api/v1/datasets/from-feedback

Builds a dataset from selected feedback rows in one call. Each eligible
feedback row becomes one example: `input` = the captured prompt variables
from the feedback's source trace, `criteria` = the feedback's `comment`.
`overall_feedback` (optional) is a dataset-level rubric applied on top of
each example's own criteria. Feedback rows are only eligible if their
source trace has captured payloads (`span_payloads.variables`) — this
example uses a feedback row from a real gateway completion made with
`x-capture-payloads: true` and a prompt-ref body
(`{"prompt":{"name":"greeting-e2task4","alias":"production","variables":{"name":"Alice"}}}`),
then `POST /traces/:id/feedback` with `{"rating":-1,"comment":"Use third
person, do not say I"}`.

`feedback_ids` takes at most 100 ids per request — the build runs
synchronously and reads several rows per id. Split a larger selection into
batches; each batch builds its own dataset.

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/from-feedback \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "unhappy-greetings", "overall_feedback": "Always third person", "feedback_ids": ["44c64fa2-8189-4ab0-a08a-a28a14893a06"]}'
```

Response (status 201):

```json
{
  "id": "4c979706-3e84-4e8f-a089-6ce4dd9f6e4a",
  "name": "unhappy-greetings",
  "overall_feedback": "Always third person",
  "example_count": 1,
  "skipped": []
}
```

The created example, as seen via GET /api/v1/datasets/:id (below):

```json
{
  "id": "fe8244a4-e9c6-4a38-a061-4e27faa778f8",
  "datasetId": "4c979706-3e84-4e8f-a089-6ce4dd9f6e4a",
  "input": { "name": "Alice" },
  "criteria": "Use third person, do not say I",
  "sourceTraceId": "131cffd7-3729-4b69-95e1-7c073ecffdc9",
  "sourceFeedbackId": "44c64fa2-8189-4ab0-a08a-a28a14893a06",
  "sourcePromptVersionId": "41014d2e-9a06-4053-9514-afacc4b06676",
  "createdAt": "2026-07-07T08:31:14.773Z"
}
```

---

#### Mixed eligibility — one captured, one not (`skipped` populated)

A second gateway completion was made against the same prompt WITHOUT the
`x-capture-payloads` header, so its trace has no `span_payloads` row.
Feedback was posted on that trace too (`{"comment": "no captured
variables"}`), then both feedback ids were passed together:

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/from-feedback \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "mixed-eligibility", "feedback_ids": ["44c64fa2-8189-4ab0-a08a-a28a14893a06", "3ef48b8c-c731-441d-8c76-0019f2807b3d"]}'
```

Response (status 201) — one example built, the uncaptured one skipped with a reason:

```json
{
  "id": "9330c7d0-1dc1-4642-815c-0bfbd0f56d97",
  "name": "mixed-eligibility",
  "overall_feedback": null,
  "example_count": 1,
  "skipped": [
    { "feedbackId": "3ef48b8c-c731-441d-8c76-0019f2807b3d", "reason": "no captured variables (payload capture was off)" }
  ]
}
```

---

#### Error responses

All requested feedback ids are ineligible (no captured variables) — 422,
same as "none eligible" below rather than a partial 201:

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/from-feedback \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "empty", "feedback_ids": ["3ef48b8c-c731-441d-8c76-0019f2807b3d"]}'
```

```json
{ "error": { "code": "UNPROCESSABLE", "message": "No eligible feedback rows — enable payload capture and collect new traffic" } }
```

A feedback id that does not exist (status 422, same message/code as above —
a nonexistent id is just another way to have zero eligible rows):

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/from-feedback \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "missing", "feedback_ids": ["00000000-0000-0000-0000-000000000000"]}'
```

```json
{ "error": { "code": "UNPROCESSABLE", "message": "No eligible feedback rows — enable payload capture and collect new traffic" } }
```

More than 100 `feedback_ids` (status 400) — the request is rejected before any
row is read, so no dataset is created:

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/from-feedback \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "too-many", "feedback_ids": ["<101 uuids>"]}'
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Array must contain at most 100 element(s)" } }
```

Note: the all-eligible-plus-team-isolation scenarios (every requested
feedback id eligible; a cross-team feedback id skipped/422) are covered by
the automated test suite (`apps/api/src/evaluations/datasets/datasets.test.ts`)
and were not separately re-curled here since the mixed-eligibility case
above already exercises the same code path with real data.

---

#### Multi-turn feedback captures the prior-turn history

When the flagged trace's `session_id` links it to earlier traces in the same
conversation, the example built from that feedback also carries a
reconstructed `history` — every prior turn's user/assistant messages, tool
calls, and tool results, in order. `example_count` is still 1: this is the
same example row, with one extra field. This example reused the `production`
alias trace from above, first replaying a prior turn in the same session
(`x-session-id` header, not shown — captured payloads are enough for the
reconstruction) and leaving feedback on the second turn:

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/from-feedback \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "doc-history-demo-dataset", "feedback_ids": ["113ebbdf-ef46-41d4-8b93-1dd5f3f6aeef"]}'
```

The created example, as seen via `GET /api/v1/datasets/:id`:

```json
{
  "id": "ef1d5b62-014f-43e4-be78-ed8c20c4a80a",
  "datasetId": "71e14e39-574d-49ee-a2e3-776994e7d563",
  "input": { "question": "And what is its population?" },
  "criteria": "Give the population as of the most recent census, with a year.",
  "history": [
    { "role": "user", "content": "What is the capital of France?" },
    { "role": "assistant", "content": "The capital of France is Paris." }
  ],
  "sourceTraceId": "11111111-1111-1111-1111-111111111112",
  "sourceFeedbackId": "113ebbdf-ef46-41d4-8b93-1dd5f3f6aeef",
  "sourcePromptVersionId": "51c52ee0-23db-454b-b044-a6a1a242f8e5",
  "createdAt": "2026-08-03T20:59:15.345Z"
}
```

A single-turn example (no `session_id`, or the first turn in a session) has
`history: null` — see the first example at the top of this page, predating
this field. `history` is also `null` when the prior turns' spans hold nothing
readable to replay: reconstruction is extra context on the example, never the
example itself, so it degrades to `null` instead of failing the build.

Prior turns recorded by the TypeScript or Python SDK's auto-trace are read the
same way as ones the gateway recorded — the two write their captured payloads
in different shapes and both are understood. When a turn was reported twice
(the gateway writes its own span and the SDK self-reports one for the same
call), it appears once in `history`.

Every eval run freezes an example's `history` at run-start time and replays
it ahead of the new turn, so a candidate prompt is judged against the same
conversation the model actually saw — see `GET
/api/v1/runs/:id/cells/:cellKey` in the [experiments reference](./experiments.md).

---

### GET /api/v1/datasets

Lists the team's non-deleted datasets, newest activity first. No pagination
params observed in the controller (returns the full team list in `data`).

```bash
curl $ACRUXCORE_BASE_URL/datasets \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "data": [
    {
      "id": "4c979706-3e84-4e8f-a089-6ce4dd9f6e4a",
      "teamId": "fcfb223d-2780-458b-adc5-ec53cf87f740",
      "name": "unhappy-greetings",
      "overallFeedback": "Always third person",
      "createdBy": "d0d70477-ecc2-4f1f-85a8-a382acf67e4d",
      "createdAt": "2026-07-07T08:31:14.772Z",
      "updatedAt": "2026-07-07T08:31:14.772Z",
      "exampleCount": 1
    }
  ]
}
```

---

### GET /api/v1/datasets/:id

Fetches one dataset with its full example list (unlike the list endpoint,
which only returns `exampleCount`).

```bash
curl $ACRUXCORE_BASE_URL/datasets/4c979706-3e84-4e8f-a089-6ce4dd9f6e4a \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "id": "4c979706-3e84-4e8f-a089-6ce4dd9f6e4a",
  "teamId": "fcfb223d-2780-458b-adc5-ec53cf87f740",
  "name": "unhappy-greetings",
  "overallFeedback": "Always third person",
  "createdBy": "d0d70477-ecc2-4f1f-85a8-a382acf67e4d",
  "createdAt": "2026-07-07T08:31:14.772Z",
  "updatedAt": "2026-07-07T08:31:14.772Z",
  "exampleCount": 1,
  "examples": [
    {
      "id": "fe8244a4-e9c6-4a38-a061-4e27faa778f8",
      "datasetId": "4c979706-3e84-4e8f-a089-6ce4dd9f6e4a",
      "input": { "name": "Alice" },
      "criteria": "Use third person, do not say I",
      "sourceTraceId": "131cffd7-3729-4b69-95e1-7c073ecffdc9",
      "sourceFeedbackId": "44c64fa2-8189-4ab0-a08a-a28a14893a06",
      "sourcePromptVersionId": "41014d2e-9a06-4053-9514-afacc4b06676",
      "createdAt": "2026-07-07T08:31:14.773Z"
    }
  ]
}
```

---

### PATCH /api/v1/datasets/:id

Updates `name` and/or `overall_feedback`. Both fields optional; omitted
fields keep their current value.

```bash
curl -X PATCH $ACRUXCORE_BASE_URL/datasets/4c979706-3e84-4e8f-a089-6ce4dd9f6e4a \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "unhappy-greetings-v2", "overall_feedback": "Always use third person, never first person"}'
```

Response (status 200):

```json
{
  "id": "4c979706-3e84-4e8f-a089-6ce4dd9f6e4a",
  "teamId": "fcfb223d-2780-458b-adc5-ec53cf87f740",
  "name": "unhappy-greetings-v2",
  "overallFeedback": "Always use third person, never first person",
  "createdBy": "d0d70477-ecc2-4f1f-85a8-a382acf67e4d",
  "createdAt": "2026-07-07T08:31:14.772Z",
  "updatedAt": "2026-07-07T08:31:37.620Z",
  "exampleCount": 1
}
```

---

### POST /api/v1/datasets/:id/examples

Adds one example manually — no source trace/feedback needed. `input` is a
free-form object (the variable bag); `criteria` is optional. `history` is
also optional — an array of chat messages (`role`, `content`, and/or
`tool_calls`/`tool_call_id`) giving the prior turns to replay ahead of
`input` during a run; capped at 20 messages / 32KB. Omit it for a
single-turn example.

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/4c979706-3e84-4e8f-a089-6ce4dd9f6e4a/examples \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": {"name": "Bob"}, "criteria": "Say hi politely, third person"}'
```

Response (status 201) — sourceTraceId/sourceFeedbackId/sourcePromptVersionId
are null for a manually-added example, and so is `history` when the request
didn't supply one:

```json
{
  "id": "001d9f90-45fe-41f7-8f59-d1f833549fac",
  "datasetId": "4c979706-3e84-4e8f-a089-6ce4dd9f6e4a",
  "input": { "name": "Bob" },
  "criteria": "Say hi politely, third person",
  "history": null,
  "sourceTraceId": null,
  "sourceFeedbackId": null,
  "sourcePromptVersionId": null,
  "createdAt": "2026-07-07T08:31:37.634Z"
}
```

Supplying `history` explicitly:

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/71e14e39-574d-49ee-a2e3-776994e7d563/examples \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": {"question": "What about Germany?"}, "criteria": "Answer in one sentence, include the year.", "history": [{"role": "user", "content": "What is the capital of France?"}, {"role": "assistant", "content": "Paris."}]}'
```

Response (status 201):

```json
{
  "id": "b4563eb4-3add-44a0-84bc-73e673153cf0",
  "datasetId": "71e14e39-574d-49ee-a2e3-776994e7d563",
  "input": { "question": "What about Germany?" },
  "criteria": "Answer in one sentence, include the year.",
  "history": [
    { "role": "user", "content": "What is the capital of France?" },
    { "role": "assistant", "content": "Paris." }
  ],
  "sourceTraceId": null,
  "sourceFeedbackId": null,
  "sourcePromptVersionId": null,
  "createdAt": "2026-08-03T20:59:25.851Z"
}
```

A `history` longer than 20 messages is rejected (status 400):

```bash
curl -X POST $ACRUXCORE_BASE_URL/datasets/54fd9af3-c470-4d1a-a0eb-ea192b5b43ab/examples \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": {"q": "x"}, "history": [{"role": "user", "content": "m0"}, "… 21 messages …"]}'
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Array must contain at most 20 element(s)" } }
```

---

### DELETE /api/v1/datasets/:id/examples/:exampleId

Removes one example. Verified by re-fetching the dataset afterwards —
`exampleCount` dropped from 2 back to 1 and the removed example is gone
from `examples`.

```bash
curl -X DELETE $ACRUXCORE_BASE_URL/datasets/4c979706-3e84-4e8f-a089-6ce4dd9f6e4a/examples/001d9f90-45fe-41f7-8f59-d1f833549fac \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{ "success": true }
```

---

### DELETE /api/v1/datasets/:id

Soft-deletes a dataset.

```bash
curl -X DELETE $ACRUXCORE_BASE_URL/datasets/4c979706-3e84-4e8f-a089-6ce4dd9f6e4a \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{ "success": true }
```

GET on the now-soft-deleted id behaves exactly like a nonexistent id:

```bash
curl $ACRUXCORE_BASE_URL/datasets/4c979706-3e84-4e8f-a089-6ce4dd9f6e4a \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Dataset not found." } }
```

---

#### Error responses

GET a dataset id that never existed (status 404, same message as a
soft-deleted one — never distinguishes the two):

```bash
curl $ACRUXCORE_BASE_URL/datasets/00000000-0000-0000-0000-000000000000 \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Dataset not found." } }
```

No Authorization header on GET /api/v1/datasets (status 401):

```bash
curl $ACRUXCORE_BASE_URL/datasets
```

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```
