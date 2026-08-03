---
title: "Prompts"
description: "Read, search, and resolve prompts by API — create/edit/delete happen in the dashboard today."
---

# Prompts API

All endpoints verified working via curl. Document updated only after curl confirmation.

:::note[Bearer API keys work on every endpoint here]
`POST`, `PATCH`, and `DELETE` accept either a dashboard session **or** a Bearer
API key (verified via curl). Write operations require an `owner`, `admin`, or
`editor` role — a `viewer` key gets `403`. You can author prompts in
**Prompts → New prompt** in the web app or entirely over the API. See
[Authentication](/api-reference/authentication) for how to generate a token.
:::

---

### How prompts work

A **prompt** is a named container (name + description). It carries no model or
messages of its own — those live in **versions**. Creating a prompt is a
two-step flow:

1. **`POST /prompts`** — create the container (this endpoint).
2. **`POST /prompts/:id/versions`** — commit a version with the actual `model`,
   `messages`, and optional `tools`. The first version auto-creates `production`
   and `staging` aliases pointing at v1.

Think of it like a Git repo: the prompt is the repo name, each version is a
commit. Consumers reference the prompt by name and alias; you publish new
versions without changing the prompt's identity.

For a worked example see [Store prompts and tools via the API](/docs/guides/store-prompts-and-tools-via-api).

---

### POST /api/v1/prompts

Creates a new prompt (the container only — no messages yet). Accepts a Bearer
API key or a dashboard session. Role must be owner, admin, or editor (viewer
returns 403). To add the actual messages, call
[`POST /prompts/:id/versions`](/api-reference/prompts/versions) next.

Response (status 201):

```json
{
  "id": "5fd454e0-bdb2-4468-b369-7fbb3f252dca",
  "name": "customer-support",
  "description": "Handles customer support queries",
  "teamId": "a1ab6500-4819-44cf-bb42-14e637cbb51d",
  "createdBy": "94925fcd-3caa-4969-a293-25304121c77b",
  "createdAt": "2026-06-26T22:12:17.574Z"
}
```

Missing name (status 400):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "name is required." } }
```

Viewer role (status 403):

```json
{ "error": { "code": "FORBIDDEN", "message": "Insufficient role for this action." } }
```

---

### GET /api/v1/prompts

Lists active (non-deleted) prompts for the current team. Supports `?search=`, `?page=`, `?limit=`.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/prompts"
```

Or with search:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/prompts?search=customer"
```

Response (status 200):

```json
{
  "data": [
    {
      "id": "5fd454e0-bdb2-4468-b369-7fbb3f252dca",
      "name": "customer-support",
      "description": "Handles customer support queries",
      "createdAt": "2026-06-26T22:12:17.574Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

---

### GET /api/v1/prompts/:id

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/prompts/5fd454e0-bdb2-4468-b369-7fbb3f252dca"
```

Response (status 200):

```json
{
  "id": "5fd454e0-bdb2-4468-b369-7fbb3f252dca",
  "name": "customer-support",
  "description": "Handles customer support queries",
  "teamId": "a1ab6500-4819-44cf-bb42-14e637cbb51d",
  "createdBy": "94925fcd-3caa-4969-a293-25304121c77b",
  "createdAt": "2026-06-26T22:12:17.574Z"
}
```

Unknown id, soft-deleted, or belongs to another team (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Prompt not found." } }
```

---

### PATCH /api/v1/prompts/:id

Partially updates name and/or description. Accepts a Bearer API key or a
dashboard session. At least one field required. Role must be owner, admin, or editor.

Response (status 200) — returns the updated prompt:

```json
{
  "id": "5fd454e0-bdb2-4468-b369-7fbb3f252dca",
  "name": "customer-support-v2",
  "description": "Handles customer support queries",
  "teamId": "a1ab6500-4819-44cf-bb42-14e637cbb51d",
  "createdBy": "94925fcd-3caa-4969-a293-25304121c77b",
  "createdAt": "2026-06-26T22:12:17.574Z"
}
```

Empty body (status 400):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "At least one of name or description must be provided." } }
```

---

### DELETE /api/v1/prompts/:id

Soft-deletes the prompt (sets deleted_at). History is preserved. Accepts a Bearer
API key or a dashboard session. Role must be owner, admin, or editor.

Response (status 204) — no body. Prompt disappears from `GET /prompts` and `GET /prompts/:id`.

Already deleted or not found (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Prompt not found." } }
```

---

### GET /api/v1/prompt-versions/:versionId

Resolves a prompt-version UUID to its parent prompt + raw template messages.
Used to prefill the Playground from a trace/feedback span (which carries only
the version UUID). Any authenticated role. Team-scoped: a version belonging to
another team returns 404 (no cross-team leak). `model` (issue #12) is the
version's bound default model publicName, or null if unbound/deleted.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/prompt-versions/cc79f29c-d4bf-4ea0-a162-ae59f9366bd7"
```

Response (status 200):

```json
{
  "promptId": "9aa612d3-adca-4636-be06-f62465af63e6",
  "promptName": "greeting",
  "versionNumber": 1,
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Greet {{ name }}." }
  ],
  "variables": ["name"],
  "tools": [],
  "model": "gpt-4o-mini"
}
```

Not found or cross-team (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Prompt version not found" } }
```
