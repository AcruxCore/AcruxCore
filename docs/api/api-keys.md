---
sidebar_position: 2
title: "API Keys"
description: "Create, list, and revoke personal API keys — the Bearer tokens every other endpoint authenticates with."
---

# API Keys API

All endpoints verified working via curl. Document updated only after curl confirmation.

:::tip[Generate your first key in the dashboard]
Most people never call `POST /api-keys` directly — go to **Account & keys → New
key** in the web app, copy it (shown once), and export it as
`$ACRUXCORE_API_KEY`. Every endpoint in this reference authenticates with
`Authorization: Bearer $ACRUXCORE_API_KEY`. The endpoints below matter once you
want to create or revoke *additional* keys from a script.
:::

---

### POST /api/v1/api-keys

Full `key` is returned only here — it's not retrievable afterwards.

```bash
curl -X POST "$ACRUXCORE_BASE_URL/api-keys" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-dev-key"}'
```

Response (status 201):

```json
{
  "id": "8cc0b472-9f5f-440e-bf68-726cd0be165e",
  "key": "acx_sk_…",
  "name": "my-dev-key",
  "createdAt": "2026-07-25T11:13:59.739Z"
}
```

Keys look like `acx_sk_` followed by 40 URL-safe characters.

:::warning[Copy it now — it cannot be recovered]
Only a SHA-256 hash of the key is stored, so this response is the one and only
time the full value exists anywhere outside your own records. Lose it and the
only option is to revoke the key and create a new one. (The `key` value above is
truncated on purpose — never paste a real key into documentation.)
:::

---

### GET /api/v1/api-keys

Full key never returned — only `lastFour`.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/api-keys"
```

Response (status 200):

```json
[
  { "id": "8cc0b472-9f5f-440e-bf68-726cd0be165e", "name": "my-dev-key", "lastFour": "J2qz", "createdAt": "2026-07-25T11:13:59.739Z" }
]
```

---

### DELETE /api/v1/api-keys/:id

Soft-revokes the key (sets `revoked_at`); it immediately stops authenticating.
You can only revoke keys in your own team.

```bash
curl -X DELETE "$ACRUXCORE_BASE_URL/api-keys/9d4a12f2-8a6a-4a5c-a1d5-708676196c1e" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 204) — no body. The id disappears from `GET /api/v1/api-keys`.

Unknown id (or a key in another team) returns 404:

```json
{ "error": { "code": "NOT_FOUND", "message": "API key not found." } }
```
