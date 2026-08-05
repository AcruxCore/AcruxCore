---
title: "Gateway Usage & Lineage"
description: "Read gateway request logs and usage analytics, including which prompt version produced each call."
---

# Gateway Usage & Lineage API

Read-only analytics over the gateway request log, plus prompt-reference completions
that stamp the exact prompt version. All endpoints are team-scoped; usage/requests
are readable by any role (no `requireRole`). Base: `/api/v1/gateway`. Auth is a
session cookie, a personal/team API key, or a virtual key.

All examples below were verified with real curl output against a running server
(dev DB + live OpenAI and Gemini connections) and reflect the actual traffic
generated during verification.

---

### GET /api/v1/gateway/usage

Query params:
- `from`, `to` — ISO dates (default: last 30 days). Window is `[from, to)`.
- `group_by` — `day` | `model` | `virtual_key` | `provider` (default `day`).
- `virtual_key_id` — optional UUID filter to a single virtual key.

`cacheHitRate` and `errorRate` are fractions in `[0, 1]`. Invalid `group_by` →
`400 { "error": { "code": "VALIDATION_ERROR", ... } }`.

Default (`group_by=day`):

```bash
curl -s "$ACRUXCORE_BASE_URL/gateway/usage" \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
{
  "from": "2026-06-04",
  "to": "2026-07-04",
  "groupBy": "day",
  "totals": {
    "requests": 6,
    "promptTokens": 69,
    "completionTokens": 22,
    "costUsd": 0.0000219,
    "cacheHitRate": 0,
    "errorRate": 0
  },
  "buckets": [
    {
      "key": "2026-07-04",
      "requests": 6,
      "promptTokens": 69,
      "completionTokens": 22,
      "costUsd": 0.0000219
    }
  ]
}
```

Grouped by model:

```bash
curl -s "$ACRUXCORE_BASE_URL/gateway/usage?group_by=model" \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
{
  "from": "2026-06-04",
  "to": "2026-07-04",
  "groupBy": "model",
  "totals": {
    "requests": 6,
    "promptTokens": 69,
    "completionTokens": 22,
    "costUsd": 0.0000219,
    "cacheHitRate": 0,
    "errorRate": 0
  },
  "buckets": [
    { "key": "gemini-2.5-flash-lite", "requests": 1, "promptTokens": 7, "completionTokens": 1, "costUsd": 0 },
    { "key": "gpt-4o-mini", "requests": 1, "promptTokens": 12, "completionTokens": 6, "costUsd": 0.0000054 },
    { "key": "gpt-4o-mini-2024-07-18", "requests": 4, "promptTokens": 50, "completionTokens": 15, "costUsd": 0.0000165 }
  ]
}
```

Grouped by provider:

```bash
curl -s "$ACRUXCORE_BASE_URL/gateway/usage?group_by=provider" \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
{
  "from": "2026-06-04",
  "to": "2026-07-04",
  "groupBy": "provider",
  "totals": {
    "requests": 6,
    "promptTokens": 69,
    "completionTokens": 22,
    "costUsd": 0.0000219,
    "cacheHitRate": 0,
    "errorRate": 0
  },
  "buckets": [
    { "key": "gemini", "requests": 1, "promptTokens": 7, "completionTokens": 1, "costUsd": 0 },
    { "key": "openai", "requests": 5, "promptTokens": 62, "completionTokens": 21, "costUsd": 0.0000219 }
  ]
}
```

`group_by=virtual_key` is also supported; rows with a NULL virtual key are omitted
from `buckets`.

---

### GET /api/v1/gateway/requests

The paginated request log. Query params: `page`, `limit` (max 100, default 20),
`virtual_key_id`, `model`, `status` (`success` | `error` | `cache_hit`), `from`, `to`.
Rows are newest-first. No message bodies are stored (privacy default for v1).

```bash
curl -s "$ACRUXCORE_BASE_URL/gateway/requests?limit=2" \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
{
  "data": [
    {
      "id": "0cfe6ab1-7703-491e-b8ec-54c757a045ea",
      "createdAt": "2026-07-04T06:47:45.800Z",
      "virtualKeyId": null,
      "provider": "openai",
      "requestedModel": "gpt-4o-mini",
      "resolvedModel": "gpt-4o-mini-2024-07-18",
      "status": "success",
      "promptTokens": 16,
      "completionTokens": 6,
      "costUsd": 0.000006,
      "latencyMs": 1314,
      "cacheHit": false,
      "promptVersionId": "412e115d-aba4-4e0b-9404-071cfb20310e",
      "errorCode": null
    },
    {
      "id": "2d607197-5d14-43aa-8614-f6512fa30bce",
      "createdAt": "2026-07-04T06:46:43.481Z",
      "virtualKeyId": "abaaecc6-cd56-4c5e-abc9-7074e593b917",
      "provider": "openai",
      "requestedModel": "gpt-4o-mini",
      "resolvedModel": "gpt-4o-mini-2024-07-18",
      "status": "success",
      "promptTokens": 8,
      "completionTokens": 5,
      "costUsd": 0.0000042,
      "latencyMs": 1224,
      "cacheHit": false,
      "promptVersionId": null,
      "errorCode": null
    }
  ],
  "total": 6,
  "page": 1,
  "limit": 2
}
```

`virtualKeyId` is non-null for calls authenticated with a virtual key; `promptVersionId`
is non-null for calls made with a `prompt` reference (see below) — this is the
prompt → request → cost lineage seam.

---

### GET /api/v1/gateway/requests/:id

```bash
curl -s "$ACRUXCORE_BASE_URL/gateway/requests/0cfe6ab1-7703-491e-b8ec-54c757a045ea" \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
{
  "id": "0cfe6ab1-7703-491e-b8ec-54c757a045ea",
  "createdAt": "2026-07-04T06:47:45.800Z",
  "virtualKeyId": null,
  "provider": "openai",
  "requestedModel": "gpt-4o-mini",
  "resolvedModel": "gpt-4o-mini-2024-07-18",
  "status": "success",
  "promptTokens": 16,
  "completionTokens": 6,
  "costUsd": 0.000006,
  "latencyMs": 1314,
  "cacheHit": false,
  "promptVersionId": "412e115d-aba4-4e0b-9404-071cfb20310e",
  "errorCode": null
}
```

Unknown id (or a row belonging to another team) → `404`.

---

### POST /api/v1/gateway/chat/completions  (prompt reference — G8 lineage)

Send `prompt` **instead of** `messages` to render a stored prompt (by name + alias)
with Phase 1's engine and stamp `prompt_version_id` on the request row. Exactly one
of `messages` / `prompt` must be supplied.

```bash
curl -s -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"model":"gpt-4o-mini","prompt":{"name":"greeting","alias":"production","variables":{"name":"Alice"}}}'
```

Response headers (status 200):

```text
x-gateway-request-id: 0cfe6ab1-7703-491e-b8ec-54c757a045ea
x-gateway-provider: openai
x-gateway-model: gpt-4o-mini-2024-07-18
x-gateway-cost-usd: 0.000006
x-gateway-cache: miss
```

Response body (status 200):

```json
{
  "id": "chatcmpl-DxoS9Lu4YcH0NCj0NpdTXBdCtmt55",
  "model": "gpt-4o-mini-2024-07-18",
  "object": "chat.completion",
  "created": 1783147665,
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello, Alice! 🌟" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 16, "completion_tokens": 6, "total_tokens": 22 }
}
```

The resulting request row carries `promptVersionId: "412e115d-aba4-4e0b-9404-071cfb20310e"`
(see `GET /requests/:id` above) — the prompt → request → cost lineage.

Error cases (all verified):

Both messages AND prompt (or neither) → 400:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Provide exactly one of `messages` or `prompt`." } }
```

A required template variable is missing → 400:

```json
{ "error": { "code": "MISSING_VARIABLES", "message": "Required variables are missing: name" } }
```

Unknown prompt name or alias for the team → 404:

```json
{ "error": { "code": "NOT_FOUND", "message": "Prompt or alias not found" } }
```
