---
title: "Prompt Versions"
description: "Commit immutable prompt versions and fetch them back by number."
---

# Prompt Versions API

All endpoints verified working via curl. Document updated only after curl
confirmation. Unlike the parent [Prompts](/api-reference/prompts) create/edit/delete
endpoints, everything here accepts a Bearer API key. Write operations (POST)
require `owner`, `admin`, or `editor` role.

---

### POST /api/v1/prompts/:id/versions

Commits a new immutable version of a prompt. The prompt must already exist
(created via [`POST /prompts`](/api-reference/prompts#how-prompts-work)).
Version numbers are sequential
(1, 2, 3 …) per prompt. The first commit auto-creates `production` and `staging`
aliases pointing to v1; subsequent commits do not change any alias.

Optional `model` (issue #12): bind a default gateway model to this version by its
`publicName`. When set, the Playground pre-selects it and a stored-prompt gateway
call that omits `model` falls back to it (an explicit request `model` always
wins). Omitted = unbound. Every version response now carries `model`
(the bound model's current `publicName`, or `null`).

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/a95ea910-c7fc-43c5-9c68-a8750e02a8f5/versions \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"system","content":"Hello {{ name }}, welcome to {{ company }}."}]}'
```

Response (status 201) — first commit: includes aliases:

```json
{
  "id": "1f720cc8-c817-45a1-a992-02dd2f90af64",
  "promptId": "a95ea910-c7fc-43c5-9c68-a8750e02a8f5",
  "versionNumber": 1,
  "messages": [{"role":"system","content":"Hello {{ name }}, welcome to {{ company }}."}],
  "variables": ["name","company"],
  "createdBy": "...",
  "createdAt": "2026-06-26T22:39:53.801Z",
  "aliases": [
    {"alias":"production","versionId":"1f720cc8-c817-45a1-a992-02dd2f90af64"},
    {"alias":"staging","versionId":"1f720cc8-c817-45a1-a992-02dd2f90af64"}
  ]
}
```

Response (status 201) — subsequent commits: no aliases field:

```json
{
  "id": "e3d0901f-24e6-4ada-941e-5b590592d2f8",
  "promptId": "a95ea910-c7fc-43c5-9c68-a8750e02a8f5",
  "versionNumber": 2,
  "messages": [{"role":"system","content":"Hi there {{ name }}, {{ company }} is glad you are here."}],
  "variables": ["name","company"],
  "createdBy": "...",
  "createdAt": "2026-06-26T22:40:32.123Z",
  "model": null
}
```

With a bound default model (issue #12) — `model` is the model's publicName:

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/91f7b670-3305-47d0-af89-f46263cfabb7/versions \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"system","content":"Hello {{ name }}"}],"model":"gpt-4o-mini"}'
```
```json
{
  "id": "ff24e4a5-005c-46c9-8cd1-f5715907da89",
  "promptId": "91f7b670-3305-47d0-af89-f46263cfabb7",
  "versionNumber": 1,
  "messages": [{"role":"system","content":"Hello {{ name }}"}],
  "variables": ["name"],
  "createdBy": "a1ef91ce-3b55-4a70-b687-3275c1c6313f",
  "createdAt": "2026-07-12T12:00:03.873Z",
  "model": "gpt-4o-mini",
  "aliases": [
    {"id":"...","alias":"production","versionId":"ff24e4a5-005c-46c9-8cd1-f5715907da89","versionNumber":1,"updatedAt":"..."},
    {"id":"...","alias":"staging","versionId":"ff24e4a5-005c-46c9-8cd1-f5715907da89","versionNumber":1,"updatedAt":"..."}
  ]
}
```

400 — `model` is not a registered gateway model for the team (issue #12):

```json
{"error":{"code":"VALIDATION_ERROR","message":"Model 'nope-model' is not registered for this team."}}
```

400 — invalid nunjucks template syntax:

```json
{"error":{"code":"TEMPLATE_PARSE_ERROR","message":"..."}}
```

400 — missing or invalid messages field:

```json
{"error":{"code":"VALIDATION_ERROR","message":"..."}}
```

403 — viewer role cannot commit versions:

```json
{"error":{"code":"FORBIDDEN","message":"You do not have permission to perform this action."}}
```

404 — prompt does not exist:

```json
{"error":{"code":"NOT_FOUND","message":"Prompt not found"}}
```

---

### GET /api/v1/prompts/:id/versions

Lists all versions for a prompt, newest first. The `messages` field is omitted
from list items (fetch a specific version to get messages).

```bash
curl $ACRUXCORE_BASE_URL/prompts/a95ea910-c7fc-43c5-9c68-a8750e02a8f5/versions \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

With pagination:

```bash
curl "$ACRUXCORE_BASE_URL/prompts/a95ea910-c7fc-43c5-9c68-a8750e02a8f5/versions?page=1&limit=20" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "data": [
    {
      "id": "e3d0901f-24e6-4ada-941e-5b590592d2f8",
      "promptId": "a95ea910-c7fc-43c5-9c68-a8750e02a8f5",
      "versionNumber": 2,
      "variables": ["name","company"],
      "createdBy": "...",
      "createdAt": "2026-06-26T22:40:32.123Z"
    },
    {
      "id": "1f720cc8-c817-45a1-a992-02dd2f90af64",
      "promptId": "a95ea910-c7fc-43c5-9c68-a8750e02a8f5",
      "versionNumber": 1,
      "variables": ["name","company"],
      "createdBy": "...",
      "createdAt": "2026-06-26T22:39:53.801Z"
    }
  ],
  "total": 2,
  "page": 1,
  "limit": 20
}
```

---

### GET /api/v1/prompts/:id/versions/:version_number

Fetches a specific version including its full `messages` array.

```bash
curl $ACRUXCORE_BASE_URL/prompts/a95ea910-c7fc-43c5-9c68-a8750e02a8f5/versions/1 \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "id": "1f720cc8-c817-45a1-a992-02dd2f90af64",
  "promptId": "a95ea910-c7fc-43c5-9c68-a8750e02a8f5",
  "versionNumber": 1,
  "messages": [{"role":"system","content":"Hello {{ name }}, welcome to {{ company }}."}],
  "variables": ["name","company"],
  "createdBy": "...",
  "createdAt": "2026-06-26T22:39:53.801Z"
}
```

404 — version number does not exist for this prompt:

```json
{"error":{"code":"NOT_FOUND","message":"Version 99 not found for this prompt"}}
```
