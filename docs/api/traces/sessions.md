---
title: "Sessions"
description: "Group related traces under a shared session id and read them back as one rolled-up view."
---

# Sessions API

All endpoints verified working via curl. Document updated only after curl confirmation.

Base path: `/api/v1/sessions`. A *session* is a distinct `traces.session_id`
value for the team (a caller-supplied opaque string set on a trace via
`POST /api/v1/traces`). There is no dedicated sessions table — a session is a
grouped aggregate over the `traces` table. Read-only, any-role,
team-scoped. Auth: `requireAnyAuth` (session cookie or personal API key).
Traces with no `sessionId` are excluded from every session listing.

---

### GET /api/v1/sessions

Lists the team's sessions, newest activity first (ordered by most recent
trace `startedAt` within the session). Query params:

- `from`, `to` — ISO 8601; default window is the last 30 days
- `page` — 1-based, default 1
- `limit` — default 20, max 100
- `q` — optional case-insensitive substring match on session_id

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions"
```

Response (status 200):

```json
{
  "data": [
    {
      "sessionId": "beta-session-2",
      "traceCount": 1,
      "totalCostUsd": 0.000009,
      "totalTokens": 80,
      "firstAt": "2026-07-04T11:00:00.000Z",
      "lastAt": "2026-07-04T11:00:00.000Z"
    },
    {
      "sessionId": "alpha-session-1",
      "traceCount": 2,
      "totalCostUsd": 0.0000414,
      "totalTokens": 270,
      "firstAt": "2026-07-04T10:00:00.000Z",
      "lastAt": "2026-07-04T10:05:00.000Z"
    }
  ],
  "total": 2,
  "page": 1,
  "limit": 20
}
```

`alpha-session-1` above was built from two traces ingested via `POST /api/v1/traces`
(see docs/api/traces/traces.md) sharing the same `sessionId`; `traceCount`, `totalCostUsd`
and `totalTokens` are rollups across those traces, and `firstAt`/`lastAt` are the
earliest/latest trace `startedAt` in the session. A trace posted with no `sessionId`
does not appear in any session.

---

#### Pagination

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions?limit=1&page=2"
```

Response (status 200) — same two sessions as above, page 2 of size 1:

```json
{
  "data": [
    {
      "sessionId": "alpha-session-1",
      "traceCount": 2,
      "totalCostUsd": 0.0000414,
      "totalTokens": 270,
      "firstAt": "2026-07-04T10:00:00.000Z",
      "lastAt": "2026-07-04T10:05:00.000Z"
    }
  ],
  "total": 2,
  "page": 2,
  "limit": 1
}
```

---

#### Substring search (`q`)

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions?q=beta"
```

Response (status 200) — only sessions whose id contains "beta" (case-insensitive):

```json
{
  "data": [
    {
      "sessionId": "beta-session-2",
      "traceCount": 1,
      "totalCostUsd": 0.000009,
      "totalTokens": 80,
      "firstAt": "2026-07-04T11:00:00.000Z",
      "lastAt": "2026-07-04T11:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

---

#### Date filter (`from`/`to`)

The default window (no from/to) is the last 30 days. Supplying a from/to
outside a session's activity excludes it entirely — there is no partial rollup.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions?from=2026-08-01T00:00:00Z"
```

Response (status 200) — both sessions above have traces before 2026-08-01, so none match:

```json
{ "data": [], "total": 0, "page": 1, "limit": 20 }
```

---

### GET /api/v1/sessions/:id

One session's summary plus its traces (newest-first, capped at 100).
NOT date-filtered — from/to query params are ignored on this route; the
lookup is purely by session_id within the team.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions/alpha-session-1"
```

Response (status 200):

```json
{
  "session": {
    "sessionId": "alpha-session-1",
    "traceCount": 2,
    "totalCostUsd": 0.0000414,
    "totalTokens": 270,
    "firstAt": "2026-07-04T10:00:00.000Z",
    "lastAt": "2026-07-04T10:05:00.000Z"
  },
  "traces": [
    {
      "id": "86035565-cdfb-430e-9013-1264b232cd6d",
      "name": "support-agent-followup",
      "sessionId": "alpha-session-1",
      "status": "ok",
      "startedAt": "2026-07-04T10:05:00.000Z",
      "endedAt": "2026-07-04T10:05:01.500Z",
      "spanCount": 1,
      "totalCostUsd": 0.000018,
      "totalTokens": 110,
      "tags": []
    },
    {
      "id": "33781375-aefe-4e26-a6ac-4e44598b76aa",
      "name": "support-agent-run",
      "sessionId": "alpha-session-1",
      "status": "ok",
      "startedAt": "2026-07-04T10:00:00.000Z",
      "endedAt": "2026-07-04T10:00:01.200Z",
      "spanCount": 1,
      "totalCostUsd": 0.0000234,
      "totalTokens": 160,
      "tags": ["prod"]
    }
  ]
}
```

Each trace item carries `sessionId` and `tags` (added 2026-07-08) so the
payload satisfies the web client's shared TraceTable row shape.

Verified the "not date-filtered" claim: passing a from that excludes both
traces from the list view still returns the full detail unchanged:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions/alpha-session-1?from=2026-08-01T00:00:00Z"
```

Response (status 200) — identical body to the call above; from/to had no effect.

---

#### Error responses

Unknown session_id for the team (status 404):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions/does-not-exist-session"
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Session not found." } }
```

No Authorization header on either route (status 401):

```json
{ "error": { "code": "UNAUTHORIZED", "message": "API key required." } }
```

Invalid `from`/`to` on GET /sessions (status 400):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions?from=not-a-date"
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid date" } }
```

`limit` above the max of 100 (status 400):

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/sessions?limit=1000"
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Number must be less than or equal to 100" } }
```
