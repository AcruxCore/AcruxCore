---
sidebar_position: 10
title: "Import"
description: "Create a new prompt and its first version from a previously exported JSON file."
---

# Import API

## POST /api/v1/prompts/import

Creates a new prompt with version 1 and two default aliases (`production`, `staging`) from a previously exported file. Variables are always re-derived from the message templates via nunjucks AST — the `variables` field in the import payload is ignored. Name collisions are resolved automatically by appending `-imported-<unix_ms>` to the prompt name.

Requires auth (session or Bearer key). The authenticated user must have role `owner`, `admin`, or `editor`.

```bash
curl -X POST $ACRUXCORE_BASE_URL/prompts/import \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": 1,
    "exportedAt": "2026-06-26T23:07:20.238Z",
    "prompt": { "name": "greet", "description": null },
    "version": {
      "versionNumber": 1,
      "messages": [{ "role": "system", "content": "Hello {{ name }}, welcome to {{ company }}." }],
      "variables": ["company", "name"],
      "createdAt": "2026-06-26T23:06:48.866Z"
    }
  }'
```

### Response (status 201)

```json
{
  "prompt":  { "id": "f23d2ebf-b960-4df2-acbb-637baf3c9972", "name": "greet-imported-1782515240247" },
  "version": { "id": "484c9746-ac04-4719-85ee-68a5b4c4fb0e", "versionNumber": 1 }
}
```

The `name` in the response may differ from the payload if a collision was resolved.

### Error responses

schemaVersion is not 1 (status 400):

```json
{ "error": { "code": "UNSUPPORTED_SCHEMA_VERSION", "message": "Only schemaVersion 1 is supported." } }
```

prompt.name is empty or version.messages is empty (status 400):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "prompt.name must not be empty" } }
```

No auth provided (status 401):

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```
