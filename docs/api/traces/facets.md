---
title: "Trace Facets"
description: "Discover the distinct tags and metadata keys/values a team has actually used, for populating filter pickers."
---

# Trace Facets API

All endpoints verified working via curl. Document updated only after curl confirmation.

Base path: `/api/v1/traces/facets`. Read-only, team-scoped discovery endpoints
that let a filter bar populate its tag/metadata pickers from whatever the team
has actually tagged or annotated a trace with (via `tags`/`metadata` on
`POST /api/v1/traces`), instead of a hardcoded list. Any team member can read
(`requireAnyAuth` — session cookie or personal API key, no role gate). Both
routes dedupe and sort their results alphabetically, capped at 200 values.

---

### GET /api/v1/traces/facets

Returns every distinct tag and every distinct metadata key currently in use
across the team's traces. No query params. Returns empty arrays when the team
has no traces (or none carry tags/metadata).

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/facets"
```

Response (status 200) — from a team with two traces, one tagged
`["prod", "nl"]` with metadata `{"env": "prod", "lang": "nl"}`, the other
tagged `["staging"]` with metadata `{"env": "staging"}`:

```json
{
  "tags": ["nl", "prod", "staging"],
  "metadataKeys": ["env", "lang"]
}
```

Team-scoped: another team's tags/keys never appear in the response.

---

### GET /api/v1/traces/facets/values

Returns the distinct string values seen for one metadata key, across the
team's traces — populates the value picker once a metadata-key filter has
been chosen. `key` is a **required** query param.

**The response has no `key` field** — it echoes only `values`, not the key
that was queried. A caller that expects the request's `key` reflected back in
the body will not find it there.

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/facets/values?key=env"
```

Response (status 200) — for the same seed data as above (`env` set to `prod`
on one trace, `staging` on the other):

```json
{
  "values": ["prod", "staging"]
}
```

Team-scoped: another team's values for the same key never appear.

---

#### Error responses

Missing `key` query param entirely (status 400) — Zod's default
required-field message:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/facets/values"
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Required" } }
```

`key` present but blank (status 400) — a different validation failure with
its own message, since the param exists but fails the schema's `min(1)`:

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  "$ACRUXCORE_BASE_URL/traces/facets/values?key="
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "key is required." } }
```

No Authorization header, on either route (status 401):

```bash
curl "$ACRUXCORE_BASE_URL/traces/facets"
```

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```
