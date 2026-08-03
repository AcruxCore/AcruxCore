---
title: "Trace Settings"
description: "Configure team-wide trace capture behavior, such as whether payloads are stored."
---

# Trace Settings API

All endpoints verified working via curl. Document updated only after curl confirmation.

Base path: `/api/v1/traces/settings`. Team-scoped, single row per team, lazily
created on first write (`updatedAt` is `null` until the team has ever written a
value — reads before that return the default `{ capturePayloads: false,
updatedAt: null }`). `GET` allows any team member (`requireAnyAuth`); `PUT`
requires `owner` or `admin` (`requireRole('owner', 'admin')`).

---

### GET /api/v1/traces/settings

```bash
curl $ACRUXCORE_BASE_URL/traces/settings \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200) — before any write, lazy default:

```json
{
  "capturePayloads": false,
  "updatedAt": null
}
```

---

### PUT /api/v1/traces/settings

Requires owner/admin role. Toggles the team's default for whether trace
payload bodies (inputs/outputs) get captured on ingest.

```bash
curl -X PUT $ACRUXCORE_BASE_URL/traces/settings \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"capturePayloads": true}'
```

Response (status 200):

```json
{
  "capturePayloads": true,
  "updatedAt": "2026-07-12T04:22:15.921Z"
}
```

A subsequent GET reflects the same values. Emits a `trace_settings_updated`
audit event on change.

Invalid body (status 400):

```bash
curl -X PUT $ACRUXCORE_BASE_URL/traces/settings \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"capturePayloads": "yes"}'
```

Response (status 400):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "capturePayloads must be a boolean."
  }
}
```
