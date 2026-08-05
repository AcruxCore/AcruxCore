---
title: "Gateway Budgets"
description: "Cap spend team-wide or per virtual key, by day, week, month, or total."
---

# Gateway — Budgets API

Base path: `/api/v1/gateway/budgets`. Management (create/update/delete) requires
`owner` or `admin`; listing is allowed for any role. Auth is a session cookie or a
personal/team API key (`requireAnyAuth`).

A budget is a spend cap. It is **team-wide** when `virtualKeyId` is `null`, or scoped
to a single virtual key when set. `period` is one of `day | week | month | total`.
For a periodic budget `resetsAt` is the start of the next period (lazily rolled
forward on read); a `total` budget never resets (`resetsAt` is `null`).

Only one budget may exist per `(team, scope, period)` — a duplicate returns 409.

Enforcement happens in the completion pipeline (`POST /api/v1/gateway/chat/completions`):
an over-budget request is rejected with **402 `BUDGET_EXCEEDED`** before any provider
call, and an over-rate request with **429 `RATE_LIMITED`** (`Retry-After` header). See
the bottom of this file.

All examples below were verified with real curl output against a running server.

---

### POST /api/v1/gateway/budgets

Create a spend cap (owner/admin). `virtualKeyId` defaults to `null` (team-wide).

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/budgets \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"period":"month","limitUsd":50}'
```

Response (status 201):

```json
{
  "id": "03307242-ab70-4b38-bb66-bfbab644ff91",
  "virtualKeyId": null,
  "period": "month",
  "limitUsd": 50,
  "spendUsd": 0,
  "resetsAt": "2026-08-01T00:00:00.000Z",
  "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
  "createdAt": "2026-07-04T06:42:50.977Z",
  "updatedAt": "2026-07-04T06:42:50.977Z"
}
```

Creating a second budget for the same scope + period returns 409:

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/budgets \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"virtualKeyId":null,"period":"month","limitUsd":20}'
```

Response (status 409):

```json
{ "error": { "code": "BUDGET_EXISTS", "message": "A budget for this scope and period already exists." } }
```

---

### GET /api/v1/gateway/budgets

List the team's budgets with live spend (any role). Elapsed periods are reset lazily
on read.

```bash
curl $ACRUXCORE_BASE_URL/gateway/budgets \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
[
  {
    "id": "03307242-ab70-4b38-bb66-bfbab644ff91",
    "virtualKeyId": null,
    "period": "month",
    "limitUsd": 50,
    "spendUsd": 0,
    "resetsAt": "2026-08-01T00:00:00.000Z",
    "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
    "createdAt": "2026-07-04T06:42:50.977Z",
    "updatedAt": "2026-07-04T06:42:50.977Z"
  }
]
```

---

### PATCH /api/v1/gateway/budgets/:id

Update `limitUsd` and/or `period` (owner/admin). Changing `period` recomputes
`resetsAt`. Below the limit is dropped to a sub-cent value (`limitUsd` is stored at
4-decimal precision, so `0.000001` surfaces as `0`) to demonstrate 402 enforcement
next.

```bash
curl -X PATCH $ACRUXCORE_BASE_URL/gateway/budgets/03307242-ab70-4b38-bb66-bfbab644ff91 \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"limitUsd":0.000001}'
```

Response (status 200):

```json
{
  "id": "03307242-ab70-4b38-bb66-bfbab644ff91",
  "virtualKeyId": null,
  "period": "month",
  "limitUsd": 0,
  "spendUsd": 0,
  "resetsAt": "2026-08-01T00:00:00.000Z",
  "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
  "createdAt": "2026-07-04T06:42:50.977Z",
  "updatedAt": "2026-07-04T06:43:01.300Z"
}
```

---

### DELETE /api/v1/gateway/budgets/:id

Remove a cap (owner/admin). Returns 204 with no body.

```bash
curl -X DELETE $ACRUXCORE_BASE_URL/gateway/budgets/03307242-ab70-4b38-bb66-bfbab644ff91 \
  --cookie "connect.sid=<session>"
```

Response (status 204): no body.

---

## Enforcement on the completion endpoint

These are behaviours of `POST /api/v1/gateway/chat/completions` when a budget or a
virtual key's rate limit applies.

### 402 — over budget

With a team-wide budget whose spend has reached `limitUsd` (here the limit was
patched to a sub-cent value above), a call is rejected before any provider request:

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/chat/completions \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
```

Response (status 402):

```json
{ "error": { "code": "BUDGET_EXCEEDED", "message": "Team-wide budget exceeded." } }
```

(For a per-key budget the message is `Virtual key budget exceeded.`)

### 429 — over rate limit

With a virtual key created with `maxRpm: 1`, the first call succeeds and carries
`x-gateway-ratelimit-remaining: 0`; a second call within the 60s window is limited.

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/chat/completions \
  -H "Authorization: Bearer agh_sk_...REDACTED" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

Call 1 returns status 200, with header `x-gateway-ratelimit-remaining: 0`. Call 2 (within 60s) returns status 429, with header `Retry-After: 59`.

Response (status 429):

```json
{ "error": { "code": "RATE_LIMITED", "message": "Rate limit exceeded." } }
```
