---
title: "Prompt Diff"
description: "Get a unified diff between two versions of a prompt's raw template."
---

# Diff API

## GET /api/v1/prompts/:id/versions/diff

Returns a unified diff string between two versions of a prompt. The diff is computed on the raw nunjucks template strings — never rendered output.

```bash
curl -X GET "$ACRUXCORE_BASE_URL/prompts/77afb6c5-8146-4fde-96e3-493ef3751374/versions/diff?from=1&to=2" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

### Query parameters

| Param | Type   | Required | Description                         |
|-------|--------|----------|-------------------------------------|
| from  | number | yes      | Version number to diff from         |
| to    | number | yes      | Version number to diff to           |

### Response (status 200)

```json
{
  "diff": "Index: greet v1..v2\n===================================================================\n--- greet v1..v2\n+++ greet v1..v2\n@@ -1,2 +1,2 @@\n [system]\n-Hello {{ name }}, welcome to {{ company }}.\n\\ No newline at end of file\n+Hi {{ name }}! Great to have you at {{ company }}.\n\\ No newline at end of file\n",
  "fromVersion": 1,
  "toVersion": 2
}
```

Comparing a version to itself (`from=N&to=N`) returns a diff with a header but no change hunks — this is not an error.

### Error responses

```json
// 400 — query params missing or not integers
{ "error": { "code": "VALIDATION_ERROR", "message": "Expected number, received nan" } }

// 404 — prompt not found in team
{ "error": { "code": "NOT_FOUND", "message": "Prompt not found." } }

// 404 — one or both version numbers don't exist
{ "error": { "code": "NOT_FOUND", "message": "One or both version numbers not found for this prompt." } }
```
