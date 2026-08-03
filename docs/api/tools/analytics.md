---
title: "Tools Analytics"
description: "Read usage analytics for tool executions."
---

# Tools Analytics API

All endpoints verified working via curl. Document updated only after curl confirmation.

Mounted BEFORE `GET /tools/:id` in `app.ts` — otherwise Express would match
`/tools/analytics` as `:id = "analytics"`.

---

### GET /api/v1/tools/analytics

Returns per-tool call counts, error rates, and latency percentiles for the caller's
team, optionally windowed by `since`/`until` ISO-8601 timestamps (both optional; an
open bound leaves that side of the window unbounded). Any authenticated team member
may read this (no role restriction).

```bash
curl $ACRUXCORE_BASE_URL/tools/analytics \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200) — no executions yet:

```json
{ "data": [] }
```

Response (status 200) — after 2 successful executions of one tool:

```json
{
  "data": [
    { "toolName": "analytics-tool", "calls": 2, "errorRate": 0, "p50Ms": 1169, "p95Ms": 1436 }
  ]
}
```

With an explicit window that covers the executions, the result is the same.

```bash
curl "$ACRUXCORE_BASE_URL/tools/analytics?since=2026-07-01T00:00:00.000Z&until=2026-12-31T00:00:00.000Z" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

With a `since` in the future, the window excludes every execution.

```bash
curl "$ACRUXCORE_BASE_URL/tools/analytics?since=2027-01-01T00:00:00.000Z" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

```json
{ "data": [] }
```

An invalid `since` (not a valid ISO-8601 datetime) returns status 400.

```bash
curl "$ACRUXCORE_BASE_URL/tools/analytics?since=not-a-date" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid datetime" } }
```
