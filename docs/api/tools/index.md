---
title: "Tools"
description: "Create, list, update, and delete tools in the Tool Catalog."
---

# Tools API

All endpoints verified working via curl. Document updated only after curl confirmation.

All endpoints accept either a session cookie (`connect.sid`) or a Bearer API key.
Write operations (POST/PATCH/DELETE) require `owner`, `admin`, or `editor` role.

This page covers the Tool shell CRUD only. The rest of the Tool Catalog (Phase 4)
domain lives alongside it:

| Page | What it covers |
|---|---|
| [`versions.md`](./versions.md) | Commit immutable versions; `description` vs `changelog` vs `source`. |
| [`aliases.md`](./aliases.md) | The `production` and `staging` pointers, and promoting between versions. |
| [`sync.md`](./sync.md) | One-call reconcile for tools defined in code — what `@acrux.tool` uses. |
| [`resolve.md`](./resolve.md) | Batch name → model-ready function definition, plus `executorType`. |
| [`execute.md`](./execute.md) | Running an `http` executor server-side. |
| [`analytics.md`](./analytics.md) | Per-tool call counts, latency, and error rates. |

:::tip[Building a tool from code?]
Reach for [`sync.md`](./sync.md) and [`resolve.md`](./resolve.md) rather than this
page. Creating the shell here and then committing a version separately is the
dashboard's path; a decorated function does both in one call and stays idempotent
across deploys.
:::

---

### POST /api/v1/tools

Creates a new tool shell (no versions/aliases yet — commit a version separately).
`name` must match `^[a-zA-Z0-9_-]{1,64}$` (kept LLM-function-name-safe for
OpenAI/Anthropic/Gemini tool-calling compatibility).

The name must also be free within the team: `POST /tools/sync` and every
`tool_ref` find a tool by name, so two active tools sharing one would make
resolution arbitrary. Soft-deleting a tool releases its name for reuse, and two
different teams may each hold the same name.

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"get_weather","description":"Fetch current weather for a city."}'
```

Response (status 201):

```json
{
  "id": "8662ca24-69f2-4431-a7f4-82e9abc77ff1",
  "name": "get_weather",
  "description": "Fetch current weather for a city.",
  "teamId": "66e0b84e-04fb-4811-8c62-2f1018474d02",
  "createdBy": "67c79920-dda0-4916-9505-8abba3d4ea90",
  "createdAt": "2026-07-12T04:22:58.156Z"
}
```

Response (status 400) — name fails the safe-name pattern:

```json
{"error":{"code":"VALIDATION_ERROR","message":"name must match ^[a-zA-Z0-9_-]{1,64}$"}}
```

Response (status 409) — an active tool in this team already holds the name.
`PATCH /tools/:id` returns the same error when a rename would collide:

```json
{"error":{"code":"TOOL_NAME_TAKEN","message":"A tool named 'get_weather' already exists in this team."}}
```

---

### GET /api/v1/tools

Returns a paginated list of active (non-deleted) tools for the current team.
Supports `?search=`, `?page=`, `?limit=`.

```bash
curl $ACRUXCORE_BASE_URL/tools \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "data": [
    {
      "id": "8662ca24-69f2-4431-a7f4-82e9abc77ff1",
      "name": "get_weather",
      "description": "Fetch current weather for a city.",
      "teamId": "66e0b84e-04fb-4811-8c62-2f1018474d02",
      "createdBy": "67c79920-dda0-4916-9505-8abba3d4ea90",
      "createdAt": "2026-07-12T04:22:58.156Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

---

### GET /api/v1/tools/:id

Fetches a single active tool by ID.

```bash
curl $ACRUXCORE_BASE_URL/tools/8662ca24-69f2-4431-a7f4-82e9abc77ff1 \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "id": "8662ca24-69f2-4431-a7f4-82e9abc77ff1",
  "name": "get_weather",
  "description": "Fetch current weather for a city.",
  "teamId": "66e0b84e-04fb-4811-8c62-2f1018474d02",
  "createdBy": "67c79920-dda0-4916-9505-8abba3d4ea90",
  "createdAt": "2026-07-12T04:22:58.156Z"
}
```

Response (status 404) — tool not found, deleted, or belongs to another team:

```json
{"error":{"code":"NOT_FOUND","message":"Tool not found."}}
```

---

### PATCH /api/v1/tools/:id

Partially updates a tool's `name` and/or `description`. At least one field is required.

```bash
curl -X PATCH $ACRUXCORE_BASE_URL/tools/8662ca24-69f2-4431-a7f4-82e9abc77ff1 \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"description":"Fetch current weather for a city (v2)."}'
```

Response (status 200):

```json
{
  "id": "8662ca24-69f2-4431-a7f4-82e9abc77ff1",
  "name": "get_weather",
  "description": "Fetch current weather for a city (v2).",
  "teamId": "66e0b84e-04fb-4811-8c62-2f1018474d02",
  "createdBy": "67c79920-dda0-4916-9505-8abba3d4ea90",
  "createdAt": "2026-07-12T04:22:58.156Z"
}
```

Response (status 400) — neither name nor description provided:

```json
{"error":{"code":"VALIDATION_ERROR","message":"At least one of name or description must be provided."}}
```

---

### DELETE /api/v1/tools/:id

Soft-deletes a tool (`deleted_at = now()`). Version and alias rows are preserved
but the tool no longer appears in list/get, and a subsequent GET returns 404.

```bash
curl -X DELETE $ACRUXCORE_BASE_URL/tools/8662ca24-69f2-4431-a7f4-82e9abc77ff1 \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 204) — no body.

Subsequent GET returns 404:

```bash
curl $ACRUXCORE_BASE_URL/tools/8662ca24-69f2-4431-a7f4-82e9abc77ff1 \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 404):

```json
{"error":{"code":"NOT_FOUND","message":"Tool not found."}}
```
