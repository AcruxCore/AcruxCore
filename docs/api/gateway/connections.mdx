---
title: "Gateway Connections"
description: "Store BYOK provider credentials (OpenAI, Anthropic, Gemini, OpenAI-compatible), encrypted at rest."
---

# Gateway — Provider Connections API

Base path: `/api/v1/gateway/connections`. BYOK (bring-your-own-key) provider
credentials, encrypted at rest (AES-256-GCM). The plaintext key is never returned —
only `keyLastFour`.

Auth: session cookie or personal/team API key (`requireAnyAuth`). Mutations
(`POST`/`PATCH`/`DELETE`) require role `owner` or `admin`; reads (`GET`) allow any
role. Supported `provider` values: `openai`, `anthropic`, `gemini`,
`openai_compatible` (the latter requires `config.base_url`).

All examples below were verified with real curl output against a running server
(dev DB, real `GATEWAY_ENCRYPTION_KEY`). Provider keys are redacted here as
`sk-...REDACTED`.

---

### POST /api/v1/gateway/connections

Create a provider connection (owner/admin). `config` defaults to `{}`.

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/connections \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"provider":"openai","label":"OpenAI Prod","apiKey":"sk-...REDACTED"}'
```

Response (status 201):

```json
{
  "id": "73c7783a-78ca-40a0-b79c-4e6026959fc8",
  "provider": "openai",
  "label": "OpenAI Prod",
  "keyLastFour": "E3AA",
  "config": {},
  "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
  "createdAt": "2026-07-04T06:41:36.413Z",
  "updatedAt": "2026-07-04T06:41:36.413Z"
}
```

A `gemini` connection is created the same way (used below to route Gemini
completions):

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/connections \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"provider":"gemini","label":"Gemini Prod","apiKey":"sk-...REDACTED"}'
```

Response (status 201):

```json
{
  "id": "ce9c1c55-1f36-47ee-bbe2-56648cfde2b8",
  "provider": "gemini",
  "label": "Gemini Prod",
  "keyLastFour": "jZMg",
  "config": {},
  "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
  "createdAt": "2026-07-04T06:41:36.431Z",
  "updatedAt": "2026-07-04T06:41:36.431Z"
}
```

For `openai_compatible`, `config.base_url` is required and must be a valid URL
(omitting it returns 400):

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/connections \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"provider":"openai_compatible","label":"Local vLLM","apiKey":"sk-...REDACTED","config":{"base_url":"https://api.example.com/v1"}}'
```

Response (status 201):

```json
{
  "id": "e5b6499c-57af-4abc-bc5e-6562b33037cc",
  "provider": "openai_compatible",
  "label": "Local vLLM",
  "keyLastFour": "-xyz",
  "config": { "base_url": "https://api.example.com/v1" },
  "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
  "createdAt": "2026-07-04T06:41:36.443Z",
  "updatedAt": "2026-07-04T06:41:36.443Z"
}
```

---

### GET /api/v1/gateway/connections

List all connections for the team (masked), newest first.

```bash
curl $ACRUXCORE_BASE_URL/gateway/connections \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
[
  {
    "id": "e5b6499c-57af-4abc-bc5e-6562b33037cc",
    "provider": "openai_compatible",
    "label": "Local vLLM",
    "keyLastFour": "-xyz",
    "config": { "base_url": "https://api.example.com/v1" },
    "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
    "createdAt": "2026-07-04T06:41:36.443Z",
    "updatedAt": "2026-07-04T06:41:36.443Z"
  },
  {
    "id": "ce9c1c55-1f36-47ee-bbe2-56648cfde2b8",
    "provider": "gemini",
    "label": "Gemini Prod",
    "keyLastFour": "jZMg",
    "config": {},
    "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
    "createdAt": "2026-07-04T06:41:36.431Z",
    "updatedAt": "2026-07-04T06:41:36.431Z"
  },
  {
    "id": "73c7783a-78ca-40a0-b79c-4e6026959fc8",
    "provider": "openai",
    "label": "OpenAI Prod",
    "keyLastFour": "E3AA",
    "config": {},
    "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
    "createdAt": "2026-07-04T06:41:36.413Z",
    "updatedAt": "2026-07-04T06:41:36.413Z"
  }
]
```

---

### GET /api/v1/gateway/connections/:id

Get one masked connection. Returns 404 if it does not belong to the team.

```bash
curl $ACRUXCORE_BASE_URL/gateway/connections/73c7783a-78ca-40a0-b79c-4e6026959fc8 \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
{
  "id": "73c7783a-78ca-40a0-b79c-4e6026959fc8",
  "provider": "openai",
  "label": "OpenAI Prod",
  "keyLastFour": "E3AA",
  "config": {},
  "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
  "createdAt": "2026-07-04T06:41:36.413Z",
  "updatedAt": "2026-07-04T06:41:36.413Z"
}
```

---

### PATCH /api/v1/gateway/connections/:id

Update the label and/or `config`, or rotate the key by supplying a new `apiKey`
(owner/admin). `provider` is immutable. Below renames a connection.

```bash
curl -X PATCH $ACRUXCORE_BASE_URL/gateway/connections/e5b6499c-57af-4abc-bc5e-6562b33037cc \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"label":"Local vLLM (renamed)"}'
```

Response (status 200):

```json
{
  "id": "e5b6499c-57af-4abc-bc5e-6562b33037cc",
  "provider": "openai_compatible",
  "label": "Local vLLM (renamed)",
  "keyLastFour": "-xyz",
  "config": { "base_url": "https://api.example.com/v1" },
  "createdBy": "6353f9ff-dc41-4b9f-9a83-237002cfc8e7",
  "createdAt": "2026-07-04T06:41:36.443Z",
  "updatedAt": "2026-07-04T06:41:46.047Z"
}
```

---

### DELETE /api/v1/gateway/connections/:id

Delete a connection (owner/admin). Returns 204 with no body.

```bash
curl -X DELETE $ACRUXCORE_BASE_URL/gateway/connections/e5b6499c-57af-4abc-bc5e-6562b33037cc \
  --cookie "connect.sid=<session>"
```

Response (status 204) — no body.
