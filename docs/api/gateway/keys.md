---
title: "Gateway Virtual Keys"
description: "Create scoped virtual keys that authenticate gateway calls without exposing your provider credentials."
---

# Gateway — Virtual Keys API

Base path: `/api/v1/gateway/keys`. Management (create/update/revoke) requires
`owner` or `admin`; listing (masked) is allowed for any role. Calling the gateway
with a key is documented in [gateway completions](index.md).

Auth for these management endpoints is a session cookie or a personal/team API
key (`requireAnyAuth`). The virtual key itself (`agh_sk_…`) authenticates calls to
`POST /api/v1/gateway/chat/completions`, not these management routes.

`allowedModels` / `allowedProviders` use `null` to mean "unrestricted".

All examples below were verified with real curl output against a running server.
Plaintext keys are redacted here as `agh_sk_...REDACTED` (the real keys were used
and authenticated successfully).

---

### POST /api/v1/gateway/keys

Create a virtual key. The plaintext `key` is returned ONLY here — store it now; it
cannot be retrieved again.

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/keys \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"name":"CI pipeline key"}'
```

Response (status 201):

```json
{
  "id": "dcde1ae5-b25f-485d-b3c2-c25a4cef0816",
  "name": "CI pipeline key",
  "key": "agh_sk_...REDACTED",
  "keyLastFour": "8hqY",
  "allowedModels": null,
  "allowedProviders": null,
  "maxRpm": null,
  "maxTpm": null,
  "cacheTtlSeconds": null,
  "createdAt": "2026-07-04T06:42:19.562Z"
}
```

A **scoped** key restricts which models it may call via `allowedModels` (and/or
`allowedProviders`), and may carry rate limits:

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/keys \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"name":"Scoped gpt-4o-mini only","allowedModels":["gpt-4o-mini"],"maxRpm":60}'
```

Response (status 201):

```json
{
  "id": "b0f2f83d-3235-4248-841b-da142ceff520",
  "name": "Scoped gpt-4o-mini only",
  "key": "agh_sk_...REDACTED",
  "keyLastFour": "d4ls",
  "allowedModels": ["gpt-4o-mini"],
  "allowedProviders": null,
  "maxRpm": 60,
  "maxTpm": null,
  "cacheTtlSeconds": null,
  "createdAt": "2026-07-04T06:42:19.590Z"
}
```

Calling completions with this scoped key on a model outside its allow-list is
rejected **before** any provider call:

```bash
curl -X POST $ACRUXCORE_BASE_URL/gateway/chat/completions \
  -H "Authorization: Bearer agh_sk_...REDACTED" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash-lite","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
```

Response (status 403):

```json
{ "error": { "code": "MODEL_NOT_ALLOWED", "message": "Model 'gemini-2.5-flash-lite' is not allowed for this key." } }
```

---

### GET /api/v1/gateway/keys

List masked keys (active + revoked) for the caller's team. Never returns the
plaintext token or the hash. Allowed for any role.

```bash
curl $ACRUXCORE_BASE_URL/gateway/keys \
  --cookie "connect.sid=<session>"
```

Response (status 200):

```json
[
  {
    "id": "b0f2f83d-3235-4248-841b-da142ceff520",
    "name": "Scoped gpt-4o-mini only",
    "keyLastFour": "d4ls",
    "allowedModels": ["gpt-4o-mini"],
    "allowedProviders": null,
    "maxRpm": 60,
    "maxTpm": null,
    "cacheTtlSeconds": null,
    "createdAt": "2026-07-04T06:42:19.590Z",
    "revokedAt": null
  },
  {
    "id": "dcde1ae5-b25f-485d-b3c2-c25a4cef0816",
    "name": "CI pipeline key",
    "keyLastFour": "8hqY",
    "allowedModels": null,
    "allowedProviders": null,
    "maxRpm": null,
    "maxTpm": null,
    "cacheTtlSeconds": null,
    "createdAt": "2026-07-04T06:42:19.562Z",
    "revokedAt": null
  }
]
```

---

### PATCH /api/v1/gateway/keys/:id

Update name / scopes / limits. Every field is optional. An allow-list of `null`
clears the restriction (unrestricted). Owner/admin only. Returns the masked key.

```bash
curl -X PATCH $ACRUXCORE_BASE_URL/gateway/keys/dcde1ae5-b25f-485d-b3c2-c25a4cef0816 \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=<session>" \
  -d '{"name":"CI pipeline key (renamed)","maxRpm":120}'
```

Response (status 200):

```json
{
  "id": "dcde1ae5-b25f-485d-b3c2-c25a4cef0816",
  "name": "CI pipeline key (renamed)",
  "keyLastFour": "8hqY",
  "allowedModels": null,
  "allowedProviders": null,
  "maxRpm": 120,
  "maxTpm": null,
  "cacheTtlSeconds": null,
  "createdAt": "2026-07-04T06:42:19.562Z",
  "revokedAt": null
}
```

---

### DELETE /api/v1/gateway/keys/:id

Soft-revoke a key (stamps `revoked_at`; historical `gateway_requests` keep their
reference). A revoked key can no longer authenticate gateway calls. Owner/admin only.
Returns 204 with no body.

```bash
curl -X DELETE $ACRUXCORE_BASE_URL/gateway/keys/b0f2f83d-3235-4248-841b-da142ceff520 \
  --cookie "connect.sid=<session>"
```

Response (status 204):

```text
(no body)
```
