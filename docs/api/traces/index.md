---
title: "Traces"
description: "Ingest and query traces — the record of one request, its spans, tokens, and cost."
---

# Traces API

All endpoints verified working via curl. Document updated only after curl confirmation.

---

### POST /api/v1/traces

Ingests a batch of OTel-shaped traces. Accepts EITHER a session cookie, a
personal API key, or a virtual key (`requireAnyAuthOrVirtualKey` — no role gate).
Each trace's spans form a tree via `spanId`/`parentSpanId`. Omit `traceId` to
mint a new trace; supply a UUID to append spans to an existing one.

```bash
curl -X POST $ACRUXCORE_BASE_URL/traces \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "traces": [
      {
        "name": "support-agent-run",
        "sessionId": "session-abc-123",
        "spans": [
          {"spanId": "s1", "name": "gpt-4o-mini", "kind": "llm", "startTime": "2026-07-04T10:00:00Z", "endTime": "2026-07-04T10:00:01.200Z", "model": "gpt-4o-mini", "provider": "openai", "usage": {"promptTokens": 120, "completionTokens": 40, "totalTokens": 160}, "costUsd": 0.0000234},
          {"spanId": "s2", "parentSpanId": "s1", "name": "search_docs", "kind": "tool", "startTime": "2026-07-04T10:00:00.100Z", "endTime": "2026-07-04T10:00:00.300Z", "status": "ok"},
          {"spanId": "s3", "parentSpanId": "s1", "name": "custom-post-process", "kind": "other", "startTime": "2026-07-04T10:00:01.000Z", "endTime": "2026-07-04T10:00:01.150Z", "status": "ok", "attributes": {"tokensSaved": 12}}
        ]
      }
    ]
  }'
```

Response (status 200):

```json
{
  "accepted": 3,
  "traceIds": ["a74e5dee-f4a6-482f-88cc-89fa332b7cc5"]
}
```

`accepted` is the total span count across the whole batch (not trace count).
`traceIds` has one entry per input trace, in order, so index i of `traceIds`
corresponds to index i of the request's `traces` array.

---

#### Appending spans to an existing trace

Supplying `traceId` appends to a trace already owned by the caller's team
(or creates it with that id if absent for the team). Cross-team traceIds are
rejected — see the 404 case below.

```bash
curl -X POST $ACRUXCORE_BASE_URL/traces \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "traces": [
      {
        "traceId": "a74e5dee-f4a6-482f-88cc-89fa332b7cc5",
        "spans": [
          {"spanId": "s4", "parentSpanId": "s1", "name": "followup-tool", "kind": "tool", "startTime": "2026-07-04T10:00:01.300Z", "endTime": "2026-07-04T10:00:01.400Z", "status": "ok"}
        ]
      }
    ]
  }'
```

Response (status 200):

```json
{
  "accepted": 1,
  "traceIds": ["a74e5dee-f4a6-482f-88cc-89fa332b7cc5"]
}
```

---

#### Error responses

No Authorization header (status 401):

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```

Empty spans array (status 400) — `spans` must have at least 1 element:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Array must contain at least 1 element(s)" } }
```

Duplicate spanId within one trace (status 400):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Duplicate spanId \"dup1\" within a trace." } }
```

parentSpanId does not match any spanId in this trace's batch or prior stored spans (status 400):

```json
{ "error": { "code": "INVALID_SPAN_PARENT", "message": "parentSpanId \"ghost\" does not reference a known span in this trace." } }
```

Supplied traceId exists but belongs to another team (status 404) — same message as an
unknown id, so the endpoint never confirms whether a foreign trace exists:

```json
{ "error": { "code": "NOT_FOUND", "message": "Trace not found." } }
```

Batch exceeds the 200-span-per-request cap (status 413):

```json
{ "error": { "code": "PAYLOAD_TOO_LARGE", "message": "Batch has 201 spans; the per-request limit is 200." } }
```

---

#### Design note: ingestion transaction scope is per-trace

Each trace in the `traces` array is resolved and appended inside its own
`prisma.$transaction`, run sequentially in a loop — there is **no** single
transaction wrapping the whole batch. In a multi-trace batch, an earlier trace
can commit successfully even if a later trace in the same request fails.

Verified: posting a batch of 2 traces where trace 1 is new/valid and trace 2
references another team's `traceId` (→ 404) returns the 404 for the whole
HTTP response, but trace 1 was already committed:

```bash
curl -X POST $ACRUXCORE_BASE_URL/traces \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "traces": [
      {"name": "partial-commit-1", "spans": [{"spanId": "pc1", "name": "a", "startTime": "2026-07-04T10:00:00Z"}]},
      {"traceId": "<another-teams-trace-id>", "spans": [{"spanId": "pc2", "name": "b", "startTime": "2026-07-04T10:00:00Z"}]}
    ]
  }'
```

Response (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Trace not found." } }
```

```sql
select id, name, team_id from traces where name = 'partial-commit-1';
--                   id                  |       name       |               team_id
-- c6350930-9324-4ea9-8cee-15ba2d8dc881 | partial-commit-1 | 76ee7c44-b305-4730-9755-a194d3d420e9
```

`partial-commit-1` is present in the database even though the request that
created it returned an error. Callers that need all-or-nothing semantics
across multiple traces must split them into separate requests and handle
partial failure themselves — this endpoint does not provide batch atomicity
across traces (only within a single trace's spans).

---

## Trace query, detail, and reverse prompt-version lineage

Read-only, team-scoped. All three routes below accept a session cookie or a
personal API key (`requireAnyAuth` — no role gate, any team member can read).
Everything runs off the single `spans` table (no UNION): span-level filters on
`GET /traces` resolve via `EXISTS (SELECT 1 FROM spans …)` sub-queries, so each
matching trace is returned exactly once even when several of its spans match.

### GET /api/v1/traces

Paginated trace list, newest first. Query params (all optional):

- `from`, `to` — ISO 8601, filtered against `traces.created_at`; default window
  is the last 30 days.
- `status` — `ok` | `error` | `unset`.
- `model`, `session_id`, `prompt_version_id` — exact match against any span in
  the trace (`prompt_version_id` is the UUID from `POST /prompts/:id/versions`).
- `min_latency_ms`, `min_cost_usd`, `min_tokens` — inclusive lower bounds.
- `q` — free-text match over trace/span name and span attributes; blank/whitespace
  is treated as "no filter".
- `page` (default 1), `limit` (default 20, max 100).

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/traces"
```

```json
{
  "data": [
    {
      "id": "6870cb11-b3a6-429a-9d8b-3952a519bf78",
      "name": "t6-error-run",
      "sessionId": "t6-session-2",
      "status": "error",
      "startedAt": "2026-07-05T00:05:00.000Z",
      "endedAt": "2026-07-05T00:05:00.800Z",
      "spanCount": 1,
      "totalCostUsd": 0.000015,
      "totalTokens": 50,
      "durationMs": 800
    },
    {
      "id": "354d5268-197d-4a8d-a664-005e8d20bbbb",
      "name": "t6-support-run",
      "sessionId": "t6-session-1",
      "status": "ok",
      "startedAt": "2026-07-05T00:00:00.000Z",
      "endedAt": "2026-07-05T00:00:02.500Z",
      "spanCount": 3,
      "totalCostUsd": 0.0000456,
      "totalTokens": 280,
      "durationMs": 2500
    }
  ],
  "total": 2,
  "page": 1,
  "limit": 20
}
```

#### Filtering by `status`

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/traces?status=error"
```

```json
{
  "data": [
    {
      "id": "6870cb11-b3a6-429a-9d8b-3952a519bf78",
      "name": "t6-error-run",
      "sessionId": "t6-session-2",
      "status": "error",
      "startedAt": "2026-07-05T00:05:00.000Z",
      "endedAt": "2026-07-05T00:05:00.800Z",
      "spanCount": 1,
      "totalCostUsd": 0.000015,
      "totalTokens": 50,
      "durationMs": 800
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

#### Filtering by `model` (span-level `EXISTS`)

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/traces?model=gpt-4o-mini"
```

```json
{
  "data": [
    {
      "id": "354d5268-197d-4a8d-a664-005e8d20bbbb",
      "name": "t6-support-run",
      "sessionId": "t6-session-1",
      "status": "ok",
      "startedAt": "2026-07-05T00:00:00.000Z",
      "endedAt": "2026-07-05T00:00:02.500Z",
      "spanCount": 3,
      "totalCostUsd": 0.0000456,
      "totalTokens": 280,
      "durationMs": 2500
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

#### Filtering by `prompt_version_id`

Only returns traces that carry a span stamped with that exact prompt version
(set via `promptVersionId` on a span in `POST /traces`, or by a gateway
completion that resolved a prompt reference):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces?prompt_version_id=4772e4b5-b34f-4cda-bc9e-f3df4de9426f"
```

```json
{
  "data": [
    {
      "id": "354d5268-197d-4a8d-a664-005e8d20bbbb",
      "name": "t6-support-run",
      "sessionId": "t6-session-1",
      "status": "ok",
      "startedAt": "2026-07-05T00:00:00.000Z",
      "endedAt": "2026-07-05T00:00:02.500Z",
      "spanCount": 3,
      "totalCostUsd": 0.0000456,
      "totalTokens": 280,
      "durationMs": 2500
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

#### Filtering by `tags` and `metadata` (T8)

`tags` is repeatable (`?tags=a&tags=b`) and matches traces that carry **all**
supplied tags (AND / has-all, via Postgres array containment `@>`). `metadata`
uses bracket-notation, also repeatable (`?metadata[k1]=v1&metadata[k2]=v2`),
and matches traces whose metadata contains **every** supplied key/value pair
(AND / jsonb containment `@>`). Every list row also now includes a `tags`
array (`metadata` is only on the detail response, `GET /traces/:id`). Pass
`-g` to curl, or URL-encode the brackets (`%5B`/`%5D`) — curl treats literal
`[`/`]` in a URL as its own globbing syntax.

```bash
curl -g -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces?tags=prod&tags=nl"
```

```json
{
  "data": [
    {
      "id": "1b2d4e99-8bfb-49f0-af63-97ae6da301f0",
      "name": "trace-both",
      "sessionId": null,
      "status": "ok",
      "startedAt": "2026-07-05T12:25:11.000Z",
      "endedAt": null,
      "spanCount": 1,
      "totalCostUsd": null,
      "totalTokens": 0,
      "durationMs": null,
      "tags": ["prod", "nl"]
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

```bash
curl -g -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces?metadata[env]=prod&metadata[lang]=nl"
```

```json
{
  "data": [
    {
      "id": "1b2d4e99-8bfb-49f0-af63-97ae6da301f0",
      "name": "trace-both",
      "sessionId": null,
      "status": "ok",
      "startedAt": "2026-07-05T12:25:11.000Z",
      "endedAt": null,
      "spanCount": 1,
      "totalCostUsd": null,
      "totalTokens": 0,
      "durationMs": null,
      "tags": ["prod", "nl"]
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

---

### GET /api/v1/traces/:id

Full trace detail: the trace header plus every span assembled into a
parent/child tree by `parentSpanId` (roots are spans with no parent, or a
dangling/cyclic `parentSpanId`). Each span carries its inline observability
fields (`model`, `usage`, `costUsd`, …) plus `promptVersionId`/
`gatewayRequestId` when the span was stamped with one. `payload` (`input`/
`output`) is present only on spans ingested with `capturePayloads: true` on
their trace.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/354d5268-197d-4a8d-a664-005e8d20bbbb"
```

```json
{
  "trace": {
    "id": "354d5268-197d-4a8d-a664-005e8d20bbbb",
    "name": "t6-support-run",
    "sessionId": "t6-session-1",
    "status": "ok",
    "startedAt": "2026-07-05T00:00:00.000Z",
    "endedAt": "2026-07-05T00:00:02.500Z",
    "spanCount": 3,
    "totalCostUsd": 0.0000456,
    "totalTokens": 280
  },
  "spans": [
    {
      "spanId": "root",
      "parentSpanId": null,
      "kind": "agent",
      "name": "support-agent",
      "status": "ok",
      "startedAt": "2026-07-05T00:00:00.000Z",
      "endedAt": "2026-07-05T00:00:02.500Z",
      "latencyMs": 2500,
      "model": null,
      "provider": null,
      "promptTokens": null,
      "completionTokens": null,
      "totalTokens": null,
      "costUsd": null,
      "promptVersionId": null,
      "gatewayRequestId": null,
      "errorMessage": null,
      "attributes": {},
      "tags": [],
      "metadata": {},
      "children": [
        {
          "spanId": "llm1",
          "parentSpanId": "root",
          "kind": "llm",
          "name": "gpt-4o-mini",
          "status": "ok",
          "startedAt": "2026-07-05T00:00:00.100Z",
          "endedAt": "2026-07-05T00:00:01.300Z",
          "latencyMs": 1200,
          "model": "gpt-4o-mini",
          "provider": "openai",
          "promptTokens": 200,
          "completionTokens": 80,
          "totalTokens": 280,
          "costUsd": 0.0000456,
          "promptVersionId": "4772e4b5-b34f-4cda-bc9e-f3df4de9426f",
          "gatewayRequestId": null,
          "errorMessage": null,
          "attributes": {},
          "tags": ["flights"],
          "metadata": { "segment": "flights" },
          "children": [],
          "payload": {
            "input": { "prompt": "You are a helpful support agent." },
            "output": { "text": "Sure, I can help with that." }
          }
        },
        {
          "spanId": "tool1",
          "parentSpanId": "root",
          "kind": "tool",
          "name": "lookup_order",
          "status": "ok",
          "startedAt": "2026-07-05T00:00:01.400Z",
          "endedAt": "2026-07-05T00:00:02.000Z",
          "latencyMs": 600,
          "model": null,
          "provider": null,
          "promptTokens": null,
          "completionTokens": null,
          "totalTokens": null,
          "costUsd": null,
          "promptVersionId": null,
          "gatewayRequestId": null,
          "errorMessage": null,
          "attributes": { "orderId": "ord_123" },
          "tags": [],
          "metadata": {},
          "children": []
        }
      ]
    }
  ]
}
```

`llm1` carries `promptVersionId` (set on ingest) and a `payload` (because the
trace was posted with `capturePayloads: true`); `root` and `tool1` have neither.
`tags`/`metadata` (T9/T10) default to `[]`/`{}` on every span; `llm1` shows a
non-empty example, of the kind set via the gateway's `x-span-tags`/
`x-span-metadata` headers on a per-call basis.

#### Unknown or foreign trace id (404)

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/00000000-0000-0000-0000-000000000000"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Trace not found" } }
```

Verified the same 404 (same message, no existence leak) when a second team's
API key requests a trace id that belongs to the first team.

---

### Trace facets

Discovering the team's distinct tags and metadata keys/values (for populating
a filter bar's pickers) is documented separately in
[Trace Facets](./facets.md) — see that page for `GET /api/v1/traces/facets`
and `GET /api/v1/traces/facets/values`.

---

### GET /api/v1/prompts/:id/versions/:version_number/traces

Reverse lineage — every trace with at least one span stamped with that exact
prompt version. Same paginated envelope as `GET /traces` (`page`, `limit` — up
to 100 — the only query params). The `:id`/`:version_number` pair is resolved
team-scoped (via the same version lookup `GET /prompts/:id/versions/:n` uses),
so an unknown or cross-team prompt/version 404s before any trace query runs.

> **Windowing note (intentional):** this lineage route is **all-time** — it has
> no `from`/`to` params and applies **no** default date window. That differs from
> `GET /traces?prompt_version_id=<id>`, which is a general list endpoint and so
> applies the standard **last-30-days** default window. Asking "which traces used
> this version?" via the two routes can therefore return different counts: the
> lineage route counts every matching trace ever; the filtered list counts only
> those in the (default or supplied) window. Use this route for a complete
> version history, the `?prompt_version_id=` filter for a time-bounded slice.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/prompts/f5250666-5775-4198-b9ef-75068249529e/versions/1/traces"
```

```json
{
  "data": [
    {
      "id": "354d5268-197d-4a8d-a664-005e8d20bbbb",
      "name": "t6-support-run",
      "sessionId": "t6-session-1",
      "status": "ok",
      "startedAt": "2026-07-05T00:00:00.000Z",
      "endedAt": "2026-07-05T00:00:02.500Z",
      "spanCount": 3,
      "totalCostUsd": 0.0000456,
      "totalTokens": 280,
      "durationMs": 2500
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

#### Error responses

Unknown prompt id for the team (status 404) — same message for a cross-team
prompt id, verified with a second team's API key:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/prompts/00000000-0000-0000-0000-000000000000/versions/1/traces"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Prompt not found" } }
```

Version number that doesn't exist on that prompt (status 404):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/prompts/f5250666-5775-4198-b9ef-75068249529e/versions/99/traces"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Version 99 not found for this prompt" } }
```
