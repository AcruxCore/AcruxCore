---
title: "Tool Sync"
description: "Create-or-commit-or-nothing: reconcile a tool defined in code with the catalog in one call."
---

# Tool Sync API

All endpoints verified working via curl. Document updated only after curl confirmation.

`POST /tools/sync` is the endpoint the SDKs' `@acrux.tool` decorator uses. It
identifies a tool by **name**, not id, because the caller is a function in a source
file and has no id to hand. One call does what used to take four: find the tool,
create it if absent, commit a version, and move an alias — all in one transaction,
so a failure part-way cannot leave a tool holding a version no alias points at.

It is **idempotent**. The submitted `description`, `parametersSchema` and `executor`
are compared against the version the alias currently points at, with object keys
sorted first so key order is never mistaken for a change. A match commits nothing
and returns `committed: false`. `changelog` and `source` are excluded from that
comparison: a new release note is not a behaviour change.

Requires `owner`, `admin`, or `editor` role. Accepts a session cookie or a Bearer
API key.

Returns **200** in every success case, including a creation. The caller cannot know
in advance whether this is the first sync, and "did anything change" is answered by
`committed`, not by the status code.

For an `http` executor, the same deep validation as
[`versions.md`](./versions.md) runs before anything is written: transform JS is
syntax-checked, `{{secret.NAME}}` references must exist, and `url` must resolve to
a public address.

---

### POST /api/v1/tools/sync

First sync — creates the tool, commits v1, and auto-creates both aliases:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parametersSchema": {"type":"object","properties":{"city":{"type":"string","description":"City name, e.g. Lahore."}},"required":["city"]},
    "executor": {"type":"client"},
    "alias": "production",
    "changelog": "derived from get_weather()",
    "source": "code"
  }'
```

Response (status 200):

```json
{"toolId":"eb1df7c0-778c-4b89-8536-8c08a1f6d406","versionNumber":1,"committed":true,"alias":"production"}
```

Re-running the same spec commits nothing. The `parametersSchema` below is
deliberately written with its keys in a different order — key order is not a change:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parametersSchema": {"required":["city"],"properties":{"city":{"description":"City name, e.g. Lahore.","type":"string"}},"type":"object"},
    "executor": {"type":"client"},
    "alias": "production",
    "source": "code"
  }'
```

Response (status 200) — same version, nothing committed:

```json
{"toolId":"eb1df7c0-778c-4b89-8536-8c08a1f6d406","versionNumber":1,"committed":false,"alias":"production"}
```

Changing only `description` — the text the model reads — commits a new version and
moves the alias:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get_weather",
    "description": "Get the current weather, in Celsius, for a city.",
    "parametersSchema": {"type":"object","properties":{"city":{"type":"string","description":"City name, e.g. Lahore."}},"required":["city"]},
    "executor": {"type":"client"},
    "alias": "production",
    "source": "code"
  }'
```

Response (status 200):

```json
{"toolId":"eb1df7c0-778c-4b89-8536-8c08a1f6d406","versionNumber":2,"committed":true,"alias":"production"}
```

**Fields**

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must match `^[a-zA-Z0-9_-]{1,64}$`. Looked up within your team. |
| `description` | no | **What the model reads.** Part of the change comparison. Omitting it hands ownership to the dashboard — see below. |
| `changelog` | no | Note for your team, max 2000 chars. Never shown to the model, never compared. |
| `parametersSchema` | yes | JSON Schema object. Part of the change comparison. |
| `executor` | yes | `{"type":"client"}` or a full `http` executor. Part of the comparison. |
| `alias` | no | Defaults to `production`. Only this alias moves. Any name the promote endpoint accepts works; on a tool's first version it is created alongside `production` and `staging`. |
| `source` | no | Defaults to `code`. One of `code`, `dashboard`, `api`. |

**Response**

| Field | Notes |
|---|---|
| `toolId` | The tool this name resolved to, created if it did not exist. |
| `versionNumber` | The version the alias now points at. |
| `committed` | `false` means the live spec already matched and nothing was written. |
| `alias` | Echoes the alias that was targeted. |
| `supersededSource` | Present only when a commit happened **and** the version it replaced was `source: "dashboard"`. |

---

## Who owns the description

`description` is what the model reads when it decides whether to call the tool, so
which copy wins matters. The rule is: **the code owns it only when the code
actually supplies one.**

**A function with a docstring wins on every sync.** That is the point of the
function being the source of its own interface. If someone edited the description in
the dashboard in between, the next deploy supersedes their edit and says so:

```bash
# The dashboard committed v3 by hand and promoted it to production.
# The next deploy sends the docstring, which differs:
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get_weather",
    "description": "Get the current weather, in Celsius, for a city.",
    "parametersSchema": {"type":"object","properties":{"city":{"type":"string","description":"City name, e.g. Lahore."}},"required":["city"]},
    "executor": {"type":"client"},
    "source": "code"
  }'
```

Response (status 200):

```json
{"toolId":"eb1df7c0-778c-4b89-8536-8c08a1f6d406","versionNumber":4,"committed":true,"alias":"production","supersededSource":"dashboard"}
```

Nothing is lost. Versions are immutable, so v3 is still in the version list and can
be promoted back in one click. `supersededSource` exists so the SDK, the dashboard
and the audit log can all tell you a hand edit just stopped being live.

**A function without a docstring hands the description to the dashboard.** No
`description` is sent, so whatever the dashboard wrote is carried forward rather
than blanked out — and when the schema and executor are unchanged too, the sync
commits nothing at all:

```bash
# v1 came from a docstring-less function, so it has no description.
# The dashboard then committed v2 with the wording the model should read.
# Every later deploy still sends no description:
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "count_rows",
    "parametersSchema": {"type":"object","properties":{"table":{"type":"string"}},"required":["table"]},
    "executor": {"type":"client"},
    "source": "code"
  }'
```

Response (status 200) — the dashboard's v2 stays live and no version is created:

```json
{"toolId":"4d9b768c-8ccb-414d-86ab-c629b3cafff5","versionNumber":2,"committed":false,"alias":"production"}
```

Resolving the tool confirms the dashboard's text is what the model gets:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/resolve \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"refs":[{"name":"count_rows"}]}'
```

Response (status 200):

```json
{"data":[{"toolId":"4d9b768c-8ccb-414d-86ab-c629b3cafff5","versionNumber":2,"executorType":"client","function":{"name":"count_rows","description":"Count the rows in a table. Use for quick size checks, not for analytics.","parameters":{"type":"object","required":["table"],"properties":{"table":{"type":"string"}}}}}]}
```

:::note[The tool-level description is only ever filled, never overwritten]
A tool has an unversioned `description` on the shell, separate from each version's.
A sync fills it from the code when it is empty, and never changes it after that.
Versions are immutable, so superseding one destroys nothing — but the shell field
has no history, and overwriting it would throw away a human-written label with no
way back.
:::

---

## Targeting `staging`

Only the alias you name moves. A `staging` sync leaves `production` where it is,
which is how you test new wording against real traffic before releasing it:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get_weather",
    "description": "Experimental wording under test.",
    "parametersSchema": {"type":"object","properties":{"city":{"type":"string","description":"City name, e.g. Lahore."}},"required":["city"]},
    "executor": {"type":"client"},
    "alias": "staging",
    "source": "code"
  }'
```

Response (status 200):

```json
{"toolId":"eb1df7c0-778c-4b89-8536-8c08a1f6d406","versionNumber":5,"committed":true,"alias":"staging"}
```

Fetching the aliases shows `production` untouched at v4:

```bash
curl $ACRUXCORE_BASE_URL/tools/eb1df7c0-778c-4b89-8536-8c08a1f6d406/aliases \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "data": [
    {"id":"d158ce82-075f-4bde-aad5-05305348354b","alias":"production","versionId":"ed20be93-0be8-4414-90fc-459de753712e","versionNumber":4,"updatedAt":"2026-07-27T16:17:00.990Z"},
    {"id":"25dbe286-a685-4fc6-8a7e-b4d4f6597085","alias":"staging","versionId":"a8be8e65-e940-457c-9e22-7f03ce743961","versionNumber":5,"updatedAt":"2026-07-27T16:17:49.017Z"}
  ]
}
```

---

## Targeting an alias other than `production` or `staging`

`alias` accepts any name `POST /tools/:id/aliases/:alias/promote` accepts, not just
the two a tool starts with. On a tool's **first** version the requested alias is
created alongside `production` and `staging`, all three pointing at v1 — so the
alias the response names always resolves:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "lookup_order",
    "description": "Look up an order.",
    "parametersSchema": {"type":"object","properties":{"id":{"type":"string"}},"required":["id"]},
    "executor": {"type":"client"},
    "alias": "canary",
    "source": "code"
  }'
```

Response (status 200):

```json
{"toolId":"ff6e9c10-14eb-4813-a873-94dd6e52dc5a","versionNumber":1,"committed":true,"alias":"canary"}
```

```bash
curl $ACRUXCORE_BASE_URL/tools/ff6e9c10-14eb-4813-a873-94dd6e52dc5a/aliases \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

Response (status 200):

```json
{
  "data": [
    {"id":"656cbf19-dff4-42f7-b6ea-f99266bf9a3f","alias":"canary","versionId":"40ac7ab4-5562-421d-adb6-3eb3f612bed8","versionNumber":1,"updatedAt":"2026-07-28T05:48:06.889Z"},
    {"id":"0cfd9faf-410e-4c37-8550-4e0023562e28","alias":"production","versionId":"40ac7ab4-5562-421d-adb6-3eb3f612bed8","versionNumber":1,"updatedAt":"2026-07-28T05:48:06.886Z"},
    {"id":"5cc7d61b-9e59-40f6-94c2-283e6f28b4da","alias":"staging","versionId":"40ac7ab4-5562-421d-adb6-3eb3f612bed8","versionNumber":1,"updatedAt":"2026-07-28T05:48:06.886Z"}
  ]
}
```

Re-running the same call is still a no-op, as with any other alias:

```json
{"toolId":"ff6e9c10-14eb-4813-a873-94dd6e52dc5a","versionNumber":1,"committed":false,"alias":"canary"}
```

---

## Concurrency

Every writer that could claim a given `(team, tool name)` is serialised on a
transaction-scoped Postgres advisory lock, so it is safe for several processes to
sync the same tool at the same instant — which is the normal case, since
`runToolLoop` syncs before its first model call and every replica boots at once.

Ten simultaneous first syncs of a new name produce **one** tool, one version, and
exactly one `committed: true`; the other nine read the version the winner wrote and
return `committed: false`. Ten simultaneous syncs of ten *different* specs produce
ten consecutively-numbered versions with no collisions. Locks are keyed per name, so
syncing different tools never blocks.

---

## Errors

Response (status 400) — `name` fails the LLM-safe-name pattern:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"get weather!","parametersSchema":{"type":"object"},"executor":{"type":"client"}}'
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"name must match ^[a-zA-Z0-9_-]{1,64}$"}}
```

Response (status 400) — an `http` executor referencing a secret that does not exist.
This is checked before the transaction opens, so nothing is written:

```bash
curl -X POST $ACRUXCORE_BASE_URL/tools/sync \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"broken_tool",
    "parametersSchema":{"type":"object"},
    "executor":{"type":"http","method":"GET","url":"https://wttr.in/x","headers":[{"name":"x-key","value":"{{secret.NOPE}}"}]}
  }'
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Referenced secret 'NOPE' does not exist."}}
```
