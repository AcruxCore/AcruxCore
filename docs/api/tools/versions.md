---
title: "Tool Versions"
description: "Commit immutable tool versions and fetch them back by number."
---

# Tool Versions API

All endpoints verified working via curl. Document updated only after curl confirmation.

All endpoints accept either a session cookie (`connect.sid`) or a Bearer API key.
Committing a version requires `owner`, `admin`, or `editor` role; reads require any
authenticated role.

A version's `executor` is a discriminated union: `{"type":"client"}` (the
customer's own app runs the tool — nothing to validate) or a declarative
`{"type":"http", ...}` executor that the platform itself can call (see
[`execute.md`](./execute.md)). For an `http` executor, commit-time validation deep-checks
`requestTransform`/`responseTransform` JS syntax, `{{secret.NAME}}` references,
and that `url` resolves to a public (non-private/loopback) address.

The **first** version committed for a tool (`versionNumber === 1`) auto-creates
`production` and `staging` aliases pointing at it; later commits do not move
any alias — use [`aliases.md`](./aliases.md)'s promote endpoint for that.

## `description`, `changelog`, and `source`

These three fields are easy to confuse, and getting them wrong changes what the
model does:

| Field | Who reads it | Effect |
|---|---|---|
| `description` | **The model.** It decides whether to call the tool from this text. | Changing it changes the model's behaviour. |
| `changelog` | Your team, in the dashboard's version list. | None. The model never sees it. |
| `source` | The dashboard and the audit log. | Records who authored the version, so the dashboard can warn before a deploy overwrites a hand edit. |

`source` is one of `code`, `dashboard`, or `api`, and defaults to `api` on this
endpoint. **`code` cannot be claimed here** — it means "derived from a decorated
function" and is writable only by [`sync.md`](./sync.md). Without that
restriction a hand-rolled call could forge code ownership and make the dashboard
warn about an edit that no deploy would ever supersede.

If you send a `changelog` and no `description`, the response carries a `warnings`
array saying so — a release note is not what the model reads. See the example below.

---

### POST /api/v1/tools/:id/versions

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/50c99ce0-cda1-4b49-81bc-d06e091fbcc5/versions \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "v1 - calls httpbin GET",
    "parametersSchema": {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},
    "executor": {
      "type": "http",
      "url": "https://httpbin.org/get",
      "method": "GET",
      "headers": [],
      "query": [{"name":"city","value":"placeholder"}],
      "argMapping": []
    }
  }'
```

Response (status 201) — first commit: includes auto-created aliases:

```json
{
  "id": "b48008a0-d162-48cd-8ebe-e4b399dce756",
  "toolId": "50c99ce0-cda1-4b49-81bc-d06e091fbcc5",
  "versionNumber": 1,
  "description": "v1 - calls httpbin GET",
  "changelog": null,
  "source": "api",
  "parametersSchema": {"type":"object","required":["city"],"properties":{"city":{"type":"string"}}},
  "executor": {"url":"https://httpbin.org/get","type":"http","query":[{"name":"city","value":"placeholder"}],"method":"GET","headers":[],"argMapping":[]},
  "createdBy": "5b8d5fb8-a8da-4afc-9d5c-20e7c088d6e2",
  "createdAt": "2026-07-27T16:21:16.535Z",
  "aliases": [
    {"id":"5a068857-05d1-435c-802b-983c2b7ca653","alias":"production","versionId":"b48008a0-d162-48cd-8ebe-e4b399dce756","versionNumber":1,"updatedAt":"2026-07-27T16:21:16.538Z"},
    {"id":"9bce7731-321a-4cbd-9889-794357af6d9f","alias":"staging","versionId":"b48008a0-d162-48cd-8ebe-e4b399dce756","versionNumber":1,"updatedAt":"2026-07-27T16:21:16.538Z"}
  ]
}
```

A subsequent commit (v2) — no `aliases` field in the response:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/50c99ce0-cda1-4b49-81bc-d06e091fbcc5/versions \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "v2 - POST variant",
    "parametersSchema": {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},
    "executor": {"type":"http","url":"https://httpbin.org/post","method":"POST","headers":[],"query":[],"argMapping":[]}
  }'
```

Response (status 201):

```json
{
  "id": "c1cafe54-edba-4200-b1ef-0a749c2f5b75",
  "toolId": "50c99ce0-cda1-4b49-81bc-d06e091fbcc5",
  "versionNumber": 2,
  "description": "v2 - POST variant",
  "changelog": null,
  "source": "api",
  "parametersSchema": {"type":"object","required":["city"],"properties":{"city":{"type":"string"}}},
  "executor": {"url":"https://httpbin.org/post","type":"http","query":[],"method":"POST","headers":[],"argMapping":[]},
  "createdBy": "5b8d5fb8-a8da-4afc-9d5c-20e7c088d6e2",
  "createdAt": "2026-07-27T16:21:16.560Z"
}
```

A commit carrying a `changelog` but no `description` succeeds, and warns:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/4d9b768c-8ccb-414d-86ab-c629b3cafff5/versions \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "changelog": "switched to the read replica",
    "parametersSchema": {"type":"object","properties":{"table":{"type":"string"},"schema":{"type":"string"}},"required":["table"]},
    "executor": {"type":"client"},
    "source": "dashboard"
  }'
```

Response (status 201):

```json
{
  "id": "9d05c296-bdc2-4d8a-b0eb-a15e8a7e91ae",
  "toolId": "4d9b768c-8ccb-414d-86ab-c629b3cafff5",
  "versionNumber": 3,
  "description": null,
  "changelog": "switched to the read replica",
  "source": "dashboard",
  "parametersSchema": {"type":"object","required":["table"],"properties":{"table":{"type":"string"},"schema":{"type":"string"}}},
  "executor": {"type":"client"},
  "createdBy": "5b8d5fb8-a8da-4afc-9d5c-20e7c088d6e2",
  "createdAt": "2026-07-27T16:17:32.389Z",
  "warnings": ["This version has a changelog but no description, so the model will read the tool-level description instead. `description` is what the model reads; `changelog` is a note for your team."]
}
```

`warnings` is present only when there is something to warn about — it is absent, not
empty, on a clean commit.

Response (status 400) — http executor's url is not a public address (SSRF guard, defense-in-depth):

```json
{"error":{"code":"VALIDATION_ERROR","message":"Blocked address: 127.0.0.1"}}
```

Response (status 404) — tool does not exist or belongs to another team:

```json
{"error":{"code":"NOT_FOUND","message":"Tool not found."}}
```

---

### GET /api/v1/tools/:id/versions

Lists all versions for a tool, newest first. `parametersSchema`/`executor` are
omitted from list items (fetch a specific version for those), but `changelog` and
`source` are included — they are what the dashboard's version list shows.

```bash
curl $ACRUXCORE_BASE_URL/tools/4d9b768c-8ccb-414d-86ab-c629b3cafff5/versions \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200) — v1 came from a decorated function with no docstring, v2 and
v3 were committed by hand:

```json
{
  "data": [
    {
      "id": "9d05c296-bdc2-4d8a-b0eb-a15e8a7e91ae",
      "toolId": "4d9b768c-8ccb-414d-86ab-c629b3cafff5",
      "versionNumber": 3,
      "description": null,
      "changelog": "switched to the read replica",
      "source": "dashboard",
      "createdBy": "5b8d5fb8-a8da-4afc-9d5c-20e7c088d6e2",
      "createdAt": "2026-07-27T16:17:32.389Z"
    },
    {
      "id": "11e7c6b4-c112-41d5-adcb-1d96921b3bea",
      "toolId": "4d9b768c-8ccb-414d-86ab-c629b3cafff5",
      "versionNumber": 2,
      "description": "Count the rows in a table. Use for quick size checks, not for analytics.",
      "changelog": null,
      "source": "dashboard",
      "createdBy": "5b8d5fb8-a8da-4afc-9d5c-20e7c088d6e2",
      "createdAt": "2026-07-27T16:17:19.400Z"
    },
    {
      "id": "b1f4bb07-5eb6-48f7-87b8-70ad2b1f3f80",
      "toolId": "4d9b768c-8ccb-414d-86ab-c629b3cafff5",
      "versionNumber": 1,
      "description": null,
      "changelog": null,
      "source": "code",
      "createdBy": "5b8d5fb8-a8da-4afc-9d5c-20e7c088d6e2",
      "createdAt": "2026-07-27T16:17:19.355Z"
    }
  ],
  "total": 3,
  "page": 1,
  "limit": 20
}
```

---

### GET /api/v1/tools/:id/versions/:version_number

Fetches a specific version, including its full `parametersSchema` and `executor`.

```bash
curl $ACRUXCORE_BASE_URL/tools/4d9b768c-8ccb-414d-86ab-c629b3cafff5/versions/2 \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "id": "11e7c6b4-c112-41d5-adcb-1d96921b3bea",
  "toolId": "4d9b768c-8ccb-414d-86ab-c629b3cafff5",
  "versionNumber": 2,
  "description": "Count the rows in a table. Use for quick size checks, not for analytics.",
  "changelog": null,
  "source": "dashboard",
  "parametersSchema": {"type":"object","required":["table"],"properties":{"table":{"type":"string"}}},
  "executor": {"type":"client"},
  "createdBy": "5b8d5fb8-a8da-4afc-9d5c-20e7c088d6e2",
  "createdAt": "2026-07-27T16:17:19.400Z"
}
```

Response (status 404) — version number does not exist for this tool:

```json
{"error":{"code":"NOT_FOUND","message":"Version 99 not found for this tool."}}
```
