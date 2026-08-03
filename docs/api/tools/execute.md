---
title: "Tool Execute"
description: "Invoke an HTTP-backed tool version server-side and record the call."
---

# Tool Execute API

All endpoints verified working via curl. Document updated only after curl confirmation.

Accepts either a session cookie (`connect.sid`) or a Bearer API key. Requires
`owner`, `admin`, or `editor` role.

Only a version whose `executor.type` is `"http"` can be executed server-side —
a `"client"` executor means the customer's own app runs the tool, and this
endpoint returns 422 for it. The target version is resolved as: explicit
`versionNumber` in the body → named `alias` in the body → the `production`
alias by default.

Arguments are validated against the version's `parametersSchema.required` list
(a missing required key is a 400), but they are **not** auto-interpolated into
the request — a fixed `query`/`headers` entry stays fixed unless the executor
defines a `requestTransform` (or `argMapping`, resolved by a future task) to
map `arguments` into the outgoing request.

The outgoing HTTP call goes through an SSRF guard (`safeFetch`): only public
http(s) URLs are reachable, so testing this endpoint against a real target
requires a real public URL (this doc uses `https://httpbin.org`) — pointing it
at `localhost`/`127.0.0.1` is rejected by design, even in dev.

---

### POST /api/v1/tools/:id/execute

Executes the version behind the default ("production") alias.

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/8662ca24-69f2-4431-a7f4-82e9abc77ff1/execute \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"arguments":{"city":"Berlin"}}'
```

Response (status 200):

```json
{
  "result": {
    "args": {"city": "placeholder"},
    "headers": {"Content-Type": "application/json", "Host": "httpbin.org", "X-Amzn-Trace-Id": "Root=1-6a5316bb-2818b2c824233ba1133c94a1"},
    "origin": "39.40.215.16",
    "url": "https://httpbin.org/get?city=placeholder"
  },
  "status": 200,
  "latencyMs": 874,
  "toolVersionId": "b40e86ed-9dfd-44c4-bf86-038e4964be22"
}
```

Pin to an explicit version number instead of the default alias.

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/8662ca24-69f2-4431-a7f4-82e9abc77ff1/execute \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"arguments":{"city":"Berlin"},"versionNumber":1}'
```

Response (status 400) — missing required argument (per `parametersSchema.required`):

```json
{"error":{"code":"VALIDATION_ERROR","message":"Missing required argument: city"}}
```

Response (status 404) — tool, version, or alias not found:

```json
{"error":{"code":"NOT_FOUND","message":"Tool not found."}}
```

Response (status 422, code `NOT_EXECUTABLE`) — resolved version has a "client" executor (no server-side call to make):

```json
{"error":{"code":"NOT_EXECUTABLE","message":"This tool has no server-side executor."}}
```
