---
title: "Trace Analytics"
description: "Read time-series analytics over every span ingested by the gateway or the SDK."
---

# Trace Analytics API

Read-only, team-scoped time-series analytics over the whole `spans` table —
every span ingested via `POST /api/v1/traces` (gateway completions **and**
SDK-posted spans). This is a **superset** of `docs/api/gateway/usage.md`'s
`GET /gateway/usage`, which only aggregates `gateway_requests` (gateway
traffic). Any team member can read (`requireAnyAuth` — session cookie or
personal API key, no role gate). Base: `/api/v1/traces`.

All examples below were verified with real curl output against a dev server
running this branch's code (confirmed via a probe call returning the analytics
envelope, not a `:id`-route 404 — see verification note at the bottom).

---

### GET /api/v1/traces/analytics

Query params (all optional):

- `from`, `to` — ISO dates; default window is the **last 30 days** (applied to
  span `started_at`).
- `group_by` — `day` | `model` | `session` | `prompt_version` (default `day`).
- `kind` — span-kind filter: `llm` | `tool` | `retrieval` | `embedding` |
  `agent` | `chain` | `other`.
- `model` — exact-model filter.

Response shape:

```
{
  "from": "...", "to": "...", "groupBy": "...",
  "totals": {
    "requests", "errorRate", "promptTokens", "completionTokens", "totalTokens",
    "costUsd", "latencyMs": { "p50", "p95", "p99" }
  },
  "buckets": [ { "key": "...", ...same metrics as totals } ]
}
```

Notes (verified below):
- `costUsd` sums null `cost_usd` as `0`.
- Spans with a null `latency_ms` are counted in `requests` but excluded from
  the `latencyMs` percentiles.
- Buckets with a null group key (e.g. no model, no session, no prompt version)
  are **omitted** from `buckets` — they still count towards `totals`.

Data used in every example below was seeded via `POST /api/v1/traces` (see
`docs/api/traces/traces.md`):

- `t4-support-run` (2026-06-20, session `t4-session-1`): `gpt-4o-mini` llm span,
  ok, 100/40/140 tokens, `$0.00002`, latency 1200ms; plus a `tool` span (200ms
  child, not llm-kind).
- `t4-error-run` (2026-06-21, session `t4-session-2`): `gpt-4o` llm span,
  **error**, 300/0/300 tokens, `$0.00009`, latency 2000ms.
- `t4-support-followup` (2026-06-22, session `t4-session-1`): `gpt-4o-mini` llm
  span, ok, 80/20/100 tokens, `$0.000015`, latency 800ms.

None of the seeded spans carry a `promptVersionId`, which is what the
`group_by=prompt_version` example below demonstrates (empty `buckets`, null
group key omitted, `totals` still reflects all 4 spans).

---

#### Default call (`group_by=day`, explicit window)

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?from=2026-06-01&to=2026-07-01"
```

Response (status 200):

```json
{
  "from": "2026-06-01",
  "to": "2026-07-01",
  "groupBy": "day",
  "totals": {
    "requests": 4,
    "errorRate": 0.25,
    "promptTokens": 480,
    "completionTokens": 60,
    "totalTokens": 540,
    "costUsd": 0.000125,
    "latencyMs": { "p50": 1000, "p95": 1879.9999999999998, "p99": 1975.9999999999998 }
  },
  "buckets": [
    {
      "key": "2026-06-20",
      "requests": 2,
      "errorRate": 0,
      "promptTokens": 100,
      "completionTokens": 40,
      "totalTokens": 140,
      "costUsd": 0.00002,
      "latencyMs": { "p50": 700, "p95": 1150, "p99": 1190 }
    },
    {
      "key": "2026-06-21",
      "requests": 1,
      "errorRate": 1,
      "promptTokens": 300,
      "completionTokens": 0,
      "totalTokens": 300,
      "costUsd": 0.00009,
      "latencyMs": { "p50": 2000, "p95": 2000, "p99": 2000 }
    },
    {
      "key": "2026-06-22",
      "requests": 1,
      "errorRate": 0,
      "promptTokens": 80,
      "completionTokens": 20,
      "totalTokens": 100,
      "costUsd": 0.000015,
      "latencyMs": { "p50": 800, "p95": 800, "p99": 800 }
    }
  ]
}
```

`requests` on 2026-06-20 is `2` (the `tool` span counts too, even though the
`kind=llm` filter below excludes it); the `latencyMs` percentiles blend both
spans on that day.

---

#### `group_by=model`

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?group_by=model&from=2026-06-01&to=2026-07-01"
```

Response (status 200):

```json
{
  "from": "2026-06-01",
  "to": "2026-07-01",
  "groupBy": "model",
  "totals": {
    "requests": 4,
    "errorRate": 0.25,
    "promptTokens": 480,
    "completionTokens": 60,
    "totalTokens": 540,
    "costUsd": 0.000125,
    "latencyMs": { "p50": 1000, "p95": 1879.9999999999998, "p99": 1975.9999999999998 }
  },
  "buckets": [
    {
      "key": "gpt-4o",
      "requests": 1,
      "errorRate": 1,
      "promptTokens": 300,
      "completionTokens": 0,
      "totalTokens": 300,
      "costUsd": 0.00009,
      "latencyMs": { "p50": 2000, "p95": 2000, "p99": 2000 }
    },
    {
      "key": "gpt-4o-mini",
      "requests": 2,
      "errorRate": 0,
      "promptTokens": 180,
      "completionTokens": 60,
      "totalTokens": 240,
      "costUsd": 0.000035,
      "latencyMs": { "p50": 1000, "p95": 1180, "p99": 1196 }
    }
  ]
}
```

The `tool` span (no `model`) has a null group key under `group_by=model`, so it
does not appear as its own bucket — it just is not counted here since its
`model` is null; the two `gpt-4o-mini` llm spans (1200ms, 800ms) are the ones
rolled up under `gpt-4o-mini`.

---

#### `group_by=session`

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?group_by=session&from=2026-06-01&to=2026-07-01"
```

Response (status 200):

```json
{
  "from": "2026-06-01",
  "to": "2026-07-01",
  "groupBy": "session",
  "totals": {
    "requests": 4,
    "errorRate": 0.25,
    "promptTokens": 480,
    "completionTokens": 60,
    "totalTokens": 540,
    "costUsd": 0.000125,
    "latencyMs": { "p50": 1000, "p95": 1879.9999999999998, "p99": 1975.9999999999998 }
  },
  "buckets": [
    {
      "key": "t4-session-1",
      "requests": 3,
      "errorRate": 0,
      "promptTokens": 180,
      "completionTokens": 60,
      "totalTokens": 240,
      "costUsd": 0.000035,
      "latencyMs": { "p50": 800, "p95": 1160, "p99": 1192 }
    },
    {
      "key": "t4-session-2",
      "requests": 1,
      "errorRate": 1,
      "promptTokens": 300,
      "completionTokens": 0,
      "totalTokens": 300,
      "costUsd": 0.00009,
      "latencyMs": { "p50": 2000, "p95": 2000, "p99": 2000 }
    }
  ]
}
```

`t4-session-1` rolls up 3 spans total: `t4-support-run` (1 llm + 1 tool) plus
`t4-support-followup` (1 llm) — 2 llm + 1 tool = 3, matching `requests: 3`
above. `session_id` lives on `traces`, so every span across a session's traces
is joined in.

---

#### `kind=llm` filter

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?kind=llm&from=2026-06-01&to=2026-07-01"
```

Response (status 200):

```json
{
  "from": "2026-06-01",
  "to": "2026-07-01",
  "groupBy": "day",
  "totals": {
    "requests": 3,
    "errorRate": 0.3333333333333333,
    "promptTokens": 480,
    "completionTokens": 60,
    "totalTokens": 540,
    "costUsd": 0.000125,
    "latencyMs": { "p50": 1200, "p95": 1920, "p99": 1984 }
  },
  "buckets": [
    {
      "key": "2026-06-20",
      "requests": 1,
      "errorRate": 0,
      "promptTokens": 100,
      "completionTokens": 40,
      "totalTokens": 140,
      "costUsd": 0.00002,
      "latencyMs": { "p50": 1200, "p95": 1200, "p99": 1200 }
    },
    {
      "key": "2026-06-21",
      "requests": 1,
      "errorRate": 1,
      "promptTokens": 300,
      "completionTokens": 0,
      "totalTokens": 300,
      "costUsd": 0.00009,
      "latencyMs": { "p50": 2000, "p95": 2000, "p99": 2000 }
    },
    {
      "key": "2026-06-22",
      "requests": 1,
      "errorRate": 0,
      "promptTokens": 80,
      "completionTokens": 20,
      "totalTokens": 100,
      "costUsd": 0.000015,
      "latencyMs": { "p50": 800, "p95": 800, "p99": 800 }
    }
  ]
}
```

`requests` on 2026-06-20 drops from `2` to `1` compared to the unfiltered call
above — the non-llm `tool` span is excluded.

---

#### `model=` filter

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?model=gpt-4o-mini&from=2026-06-01&to=2026-07-01"
```

Response (status 200):

```json
{
  "from": "2026-06-01",
  "to": "2026-07-01",
  "groupBy": "day",
  "totals": {
    "requests": 2,
    "errorRate": 0,
    "promptTokens": 180,
    "completionTokens": 60,
    "totalTokens": 240,
    "costUsd": 0.000035,
    "latencyMs": { "p50": 1000, "p95": 1180, "p99": 1196 }
  },
  "buckets": [
    {
      "key": "2026-06-20",
      "requests": 1,
      "errorRate": 0,
      "promptTokens": 100,
      "completionTokens": 40,
      "totalTokens": 140,
      "costUsd": 0.00002,
      "latencyMs": { "p50": 1200, "p95": 1200, "p99": 1200 }
    },
    {
      "key": "2026-06-22",
      "requests": 1,
      "errorRate": 0,
      "promptTokens": 80,
      "completionTokens": 20,
      "totalTokens": 100,
      "costUsd": 0.000015,
      "latencyMs": { "p50": 800, "p95": 800, "p99": 800 }
    }
  ]
}
```

Only the two `gpt-4o-mini` spans remain; `gpt-4o` and the model-less `tool`
span are excluded.

---

#### `group_by=prompt_version` — null group key omitted

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?group_by=prompt_version&from=2026-06-01&to=2026-07-01"
```

Response (status 200):

```json
{
  "from": "2026-06-01",
  "to": "2026-07-01",
  "groupBy": "prompt_version",
  "totals": {
    "requests": 4,
    "errorRate": 0.25,
    "promptTokens": 480,
    "completionTokens": 60,
    "totalTokens": 540,
    "costUsd": 0.000125,
    "latencyMs": { "p50": 1000, "p95": 1879.9999999999998, "p99": 1975.9999999999998 }
  },
  "buckets": []
}
```

`totals` still reflects all 4 spans, but `buckets` is empty because none of
them carry a `promptVersionId` — confirming null group keys are counted in the
totals but dropped from the per-bucket breakdown.

---

#### Default window (no `from`/`to`)

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/traces/analytics"
```

Response (status 200) — no from/to supplied, so the window defaults to the
trailing 30 days computed from the server's current time (2026-07-05), i.e.
[2026-06-05, 2026-07-05). All three seeded traces (06-20/21/22) fall inside
that window, so this is identical to the explicit from=2026-06-01&to=2026-07-01
call above except for the echoed from/to:

```json
{
  "from": "2026-06-05",
  "to": "2026-07-05",
  "groupBy": "day",
  "totals": {
    "requests": 4,
    "errorRate": 0.25,
    "promptTokens": 480,
    "completionTokens": 60,
    "totalTokens": 540,
    "costUsd": 0.000125,
    "latencyMs": { "p50": 1000, "p95": 1879.9999999999998, "p99": 1975.9999999999998 }
  },
  "buckets": [
    {
      "key": "2026-06-20",
      "requests": 2,
      "errorRate": 0,
      "promptTokens": 100,
      "completionTokens": 40,
      "totalTokens": 140,
      "costUsd": 0.00002,
      "latencyMs": { "p50": 700, "p95": 1150, "p99": 1190 }
    },
    {
      "key": "2026-06-21",
      "requests": 1,
      "errorRate": 1,
      "promptTokens": 300,
      "completionTokens": 0,
      "totalTokens": 300,
      "costUsd": 0.00009,
      "latencyMs": { "p50": 2000, "p95": 2000, "p99": 2000 }
    },
    {
      "key": "2026-06-22",
      "requests": 1,
      "errorRate": 0,
      "promptTokens": 80,
      "completionTokens": 20,
      "totalTokens": 100,
      "costUsd": 0.000015,
      "latencyMs": { "p50": 800, "p95": 800, "p99": 800 }
    }
  ]
}
```

This confirms the default window is the trailing 30 days computed from the
current server time (`echoed from = to − 30d`) — not an all-time aggregate.
Supplying `from`/`to` outside the data's range narrows or empties the result
accordingly.

---

#### Error responses

Invalid `group_by` (status 400):

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?group_by=banana"
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid enum value. Expected 'day' | 'model' | 'session' | 'prompt_version', received 'banana'" } }
```

Invalid `kind` (status 400):

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?kind=banana"
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid enum value. Expected 'llm' | 'tool' | 'retrieval' | 'embedding' | 'agent' | 'chain' | 'other', received 'banana'" } }
```

Invalid `from` (status 400):

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/analytics?from=not-a-date"
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid date" } }
```

No Authorization header (status 401):

```bash
curl -s "$ACRUXCORE_BASE_URL/traces/analytics"
```

```json
{ "error": { "code": "UNAUTHORIZED", "message": "API key required." } }
```

---

#### Verification note: confirming the route serves current code

Before seeding data, a probe call with a fresh team's key against the already-
running dev server (`tsx watch server.ts`, port 3000, cwd `apps/api`, this
branch checked out) returned the analytics envelope — not a trace-not-found
404 that a stale `/traces/:id` route would produce for the literal path segment
`analytics`:

```bash
curl -s -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/traces/analytics"
```

This returned:

```json
{"from":"2026-06-05","to":"2026-07-05","groupBy":"day","totals":{"requests":0, ...},"buckets":[]}
```

This confirmed the running server already had `GET /traces/analytics` mounted
ahead of `GET /traces/:id`, so no fresh server start was needed for this task.
