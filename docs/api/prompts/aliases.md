---
title: "Prompt Aliases"
description: "List, render, and promote named pointers (production/staging) to a specific prompt version."
---

# Prompt Aliases API

All endpoints accept either a session cookie (`connect.sid`) or a Bearer API key.
Promote requires `owner`, `admin`, or `editor` role. Render and list are read-only
(any authenticated user).

---

### GET /api/v1/prompts/:id/aliases

Lists all aliases for a prompt, including which version each alias points to.

```bash
curl $ACRUXCORE_BASE_URL/prompts/a95ea910-c7fc-43c5-9c68-a8750e02a8f5/aliases \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
[
  {
    "id": "dfa7b5d8-b13d-4c2f-9f4f-055677cab1e1",
    "alias": "production",
    "versionId": "1f720cc8-c817-45a1-a992-02dd2f90af64",
    "versionNumber": 1,
    "updatedAt": "2026-06-26T22:39:53.859Z"
  },
  {
    "id": "f1112da8-dcd5-4f8b-a633-2fc0373157ea",
    "alias": "staging",
    "versionId": "1f720cc8-c817-45a1-a992-02dd2f90af64",
    "versionNumber": 1,
    "updatedAt": "2026-06-26T22:39:53.859Z"
  }
]
```

---

### POST /api/v1/prompts/:id/aliases/:alias/promote

Promotes (or creates) an alias to point to a specific version number. Also used
to roll back by promoting to an earlier version number. The `alias` can be any
string (`production`, `staging`, `canary`, etc.).

Promote production to v2:

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/a95ea910-c7fc-43c5-9c68-a8750e02a8f5/aliases/production/promote \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"version_number":2}'
```

Response (status 200):

```json
{
  "id": "dfa7b5d8-b13d-4c2f-9f4f-055677cab1e1",
  "alias": "production",
  "versionId": "e3d0901f-24e6-4ada-941e-5b590592d2f8",
  "versionNumber": 2,
  "updatedAt": "2026-06-26T22:42:29.884Z"
}
```

Rollback production to v1:

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/a95ea910-c7fc-43c5-9c68-a8750e02a8f5/aliases/production/promote \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"version_number":1}'
```

Response (status 200):

```json
{
  "id": "dfa7b5d8-b13d-4c2f-9f4f-055677cab1e1",
  "alias": "production",
  "versionId": "1f720cc8-c817-45a1-a992-02dd2f90af64",
  "versionNumber": 1,
  "updatedAt": "2026-06-26T22:42:29.915Z"
}
```

400 — version_number missing from body:

```json
{"error":{"code":"VALIDATION_ERROR","message":"..."}}
```

403 — viewer role cannot promote:

```json
{"error":{"code":"FORBIDDEN","message":"You do not have permission to perform this action."}}
```

404 — version number does not exist for this prompt:

```json
{"error":{"code":"NOT_FOUND","message":"Version 99 not found for this prompt"}}
```

---

### POST /api/v1/prompts/:name/:alias/render

Renders a prompt by its **name** (slug) and alias, substituting Jinja2/nunjucks
variables. The alias resolves to whatever version is currently promoted.

Render production (v1) — requires name + company variables:

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/greeting/production/render \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"variables":{"name":"Alice","company":"Acme Corp"}}'
```

Response (status 200) — v1 content rendered:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "Hello Alice, welcome to Acme Corp."
    }
  ],
  "tools": [],
  "versionId": "475725df-725a-45c6-a195-05ca2e29cb95",
  "versionNumber": 1
}
```

`versionId`/`versionNumber` identify the exact prompt version that produced this render —
pass either through as `promptVersionId` on the SDK's `chat()`/`runToolLoop()` so a trace can
be linked back to it.

`tools` (TC3) is always present — an array of OpenAI-shaped function definitions for
any Tool Catalog tools attached to the resolved version (via `tools: [{ toolId, alias?,
pinnedVersionNumber? }]` on `POST /api/v1/prompts/:id/versions`), or `[]` when none are
attached. Curl-verified with a version that has a tool attached:

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/weather-assistant/production/render \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"variables":{"city":"Paris"}}'
```

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful weather assistant." },
    { "role": "user", "content": "What is the weather in Paris?" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Looks up current weather for a city",
        "parameters": {
          "type": "object",
          "required": ["city"],
          "properties": { "city": { "type": "string" } }
        }
      }
    }
  ],
  "versionId": "124be949-a90c-424c-b337-9e23ef9eb907",
  "versionNumber": 1
}
```

After promoting production to v2:

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/greeting/production/render \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"variables":{"name":"Alice","company":"Acme Corp"}}'
```

Response (status 200) — v2 content rendered:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "Hi there Alice, Acme Corp is glad you are here."
    }
  ],
  "tools": [],
  "versionId": "b10ae99f-ff5d-4df6-a0d4-f33740ef950f",
  "versionNumber": 2
}
```

400 MISSING_VARIABLES — required template variables absent:

```json
{
  "error": {
    "code": "MISSING_VARIABLES",
    "message": "Required variables are missing: company, name",
    "missing": ["company", "name"]
  }
}
```

404 — prompt name not found:

```json
{"error":{"code":"NOT_FOUND","message":"Prompt or alias not found"}}
```

404 — alias not found for this prompt:

```json
{"error":{"code":"NOT_FOUND","message":"Prompt or alias not found"}}
```
