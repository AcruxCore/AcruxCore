---
sidebar_position: 12
title: "Audit"
description: "Read the paginated, newest-first audit trail of changes made to a prompt."
---

# Audit API

## GET /api/v1/prompts/:id/audit

Returns a paginated, newest-first list of audit events for a specific prompt. Each event includes the actor (user who triggered it) and a metadata payload describing what changed.

Requires auth (session or Bearer key). The prompt must belong to the authenticated user's team.

```bash
curl -X GET "$ACRUXCORE_BASE_URL/prompts/77afb6c5-8146-4fde-96e3-493ef3751374/audit" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

### Query parameters

| Param | Type   | Default | Description                      |
|-------|--------|---------|----------------------------------|
| page  | number | 1       | 1-indexed page number            |
| limit | number | 20      | Page size (max 100)              |

### Response (status 200)

```json
{
  "data": [
    {
      "id": "a34946a8-c5cb-47ff-9d64-3a179c81baeb",
      "event": "version_committed",
      "actor": { "id": "5fc99de4-ca8d-4a7e-9946-9e77dcb0fa62", "email": "b5v3@example.com" },
      "metadata": { "versionNumber": 2 },
      "createdAt": "2026-06-26T23:06:48.883Z"
    },
    {
      "id": "2615b9bd-d1f0-4336-9d91-e39ebbc59e4e",
      "event": "version_committed",
      "actor": { "id": "5fc99de4-ca8d-4a7e-9946-9e77dcb0fa62", "email": "b5v3@example.com" },
      "metadata": { "versionNumber": 1 },
      "createdAt": "2026-06-26T23:06:48.872Z"
    },
    {
      "id": "8c86bf20-078d-48cf-a068-3a38a4f8364e",
      "event": "prompt_created",
      "actor": { "id": "5fc99de4-ca8d-4a7e-9946-9e77dcb0fa62", "email": "b5v3@example.com" },
      "metadata": { "name": "greet" },
      "createdAt": "2026-06-26T23:06:48.844Z"
    }
  ],
  "total": 3,
  "page": 1,
  "limit": 20
}
```

### Paginated example

```bash
curl -X GET "$ACRUXCORE_BASE_URL/prompts/77afb6c5-8146-4fde-96e3-493ef3751374/audit?page=1&limit=2" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

```json
{
  "data": [ ... 2 items ... ],
  "total": 3,
  "page": 1,
  "limit": 2
}
```

### Error responses

Response (status 404) — prompt not found or belongs to another team:

```json
{ "error": { "code": "NOT_FOUND", "message": "Prompt not found." } }
```
