---
sidebar_position: 11
title: "Export"
description: "Download a prompt version as a portable JSON file for backup or re-import."
---

# Export API

## GET /api/v1/prompts/:id/versions/:version_number/export

Returns a portable JSON export file for a specific prompt version. The response sets `Content-Disposition: attachment` so browsers offer it as a file download. The exported file can be re-imported via `POST /api/v1/prompts/import`.

```bash
curl -X GET "$ACRUXCORE_BASE_URL/prompts/77afb6c5-8146-4fde-96e3-493ef3751374/versions/1/export" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

### Response headers (status 200)

```text
Content-Type: application/json; charset=utf-8
Content-Disposition: attachment; filename="greet-v1.json"
```

### Response body (status 200)

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-06-26T23:07:20.238Z",
  "prompt": {
    "name": "greet",
    "description": null
  },
  "version": {
    "versionNumber": 1,
    "messages": [
      { "role": "system", "content": "Hello {{ name }}, welcome to {{ company }}." }
    ],
    "variables": ["company", "name"],
    "createdAt": "2026-06-26T23:06:48.866Z"
  }
}
```

### Error responses

Prompt not found in team (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Prompt not found." } }
```

Version number does not exist (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Version not found." } }
```
