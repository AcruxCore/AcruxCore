---
title: "Gateway Models"
description: "Register a public model name that maps to a credential and an upstream provider model."
---

# Gateway — Model Registry API

Base path: `/api/v1/gateway/models`. A **model** is a named deployment: a
team-chosen `publicName` (what callers send as `model`) → an `upstreamModel` (what
is actually sent to the provider) → a bound credential → its own pricing. A
request's `model` resolves here — there is no provider name-inference — so any
provider/aggregator (OpenRouter, Together, local vLLM) works once registered.

Auth: session cookie or personal/team API key (`requireAnyAuth`). Mutations
(`POST`/`PATCH`/`DELETE`) and `POST /:id/test` require role `owner` or `admin`;
reads (`GET`) allow any role.

Pricing is USD per 1M tokens. On create, omitted prices are prefilled from the
static registry for known upstream ids; unknown ids default to `null` (cost logged
null) and can be set manually. `fallbackModelIds` is an ordered list of *other*
registered models tried on failure.

All examples below were verified with real curl output against a running server
(dev DB, real `GATEWAY_ENCRYPTION_KEY`).

---

### POST /api/v1/gateway/models

Register a model (owner/admin). Unknown upstream id → prices null.

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/models \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"publicName":"claude-via-or","upstreamModel":"anthropic/claude-3.5-sonnet","credentialId":"48e1abec-3fad-4c4f-ad36-9968cf116baa"}'
```

Response (status 201):

```json
{
  "id": "ef2ccd0a-64af-498f-866b-2f27cc5e33d7",
  "publicName": "claude-via-or",
  "upstreamModel": "anthropic/claude-3.5-sonnet",
  "credentialId": "48e1abec-3fad-4c4f-ad36-9968cf116baa",
  "credentialLabel": "OpenRouter",
  "provider": "openai_compatible",
  "inputPricePerM": null,
  "outputPricePerM": null,
  "fallbacks": [],
  "createdAt": "2026-07-04T12:21:51.420Z",
  "updatedAt": "2026-07-04T12:21:51.420Z"
}
```

Errors: `400 VALIDATION_ERROR` (bad body); `400 INVALID_FALLBACK` (unknown/self
fallback id); `409` (duplicate `publicName` for the team).

---

### GET /api/v1/gateway/models

List the team's models, newest first (any role).

```bash
curl $ACRUXCORE_BASE_URL/gateway/models \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
[
  {
    "id": "ef2ccd0a-64af-498f-866b-2f27cc5e33d7",
    "publicName": "claude-via-or",
    "upstreamModel": "anthropic/claude-3.5-sonnet",
    "credentialId": "48e1abec-3fad-4c4f-ad36-9968cf116baa",
    "credentialLabel": "OpenRouter",
    "provider": "openai_compatible",
    "inputPricePerM": null,
    "outputPricePerM": null,
    "fallbacks": [],
    "createdAt": "2026-07-04T12:21:51.420Z",
    "updatedAt": "2026-07-04T12:21:51.420Z"
  }
]
```

---

### PATCH /api/v1/gateway/models/:id

Update in place (owner/admin). Omitted price fields are unchanged; passing
`fallbackModelIds` replaces the whole ordered chain. The public name stays
callable across the edit.

```bash
curl -X PATCH $ACRUXCORE_BASE_URL/gateway/models/ef2ccd0a-64af-498f-866b-2f27cc5e33d7 \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"inputPricePerM":3,"outputPricePerM":15}'
```

Response (status 200) — excerpt:

```json
{ "publicName": "claude-via-or", "inputPricePerM": 3, "outputPricePerM": 15 }
```

---

### DELETE /api/v1/gateway/models/:id

Delete a model (owner/admin). Blocked while it is another model's fallback.

```bash
curl -i -X DELETE $ACRUXCORE_BASE_URL/gateway/models/<fallback-id> \
  --cookie "connect.sid=<session>"
```

Response (status 409):

```json
{ "error": { "code": "MODEL_IS_FALLBACK", "message": "This model is used as a fallback by another model." } }
```

On success: `204 No Content`. Deleting a *credential* still bound to a model is
likewise blocked: `409 CREDENTIAL_IN_USE` from `DELETE /gateway/connections/:id`.

---

### POST /api/v1/gateway/models/:id/test

Fire a diagnostic 1-token completion through the model's credential (owner/admin).
Never throws to the client; a provider failure returns `ok:false`. Does not count
against budgets or the usage log.

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/models/ef2ccd0a-64af-498f-866b-2f27cc5e33d7/test \
  --cookie "connect.sid=<session>"
```

Response (status 200) — a bad/placeholder key surfaces the provider error:

```json
{ "ok": false, "error": "OpenAI error 401: {\"error\":{\"message\":\"Missing Authentication header\",\"code\":401}}" }
```

A working key returns `{ "ok": true, "latencyMs": 512 }`.
