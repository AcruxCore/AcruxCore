---
title: "Authentication"
description: "Generate a Bearer token in the dashboard, then use it on every endpoint in this reference."
sidebar_position: 1
---

# Authentication

Every endpoint in this reference authenticates the same way: a **Bearer API
key** in the `Authorization` header. Generate that key once in the dashboard,
then reuse it for every call below.

## 1. Create a key in the dashboard

Sign up or log in to the web app, then go to **Account & keys → New key**.
Copy the key now — it's shown only once.

## 2. Export it as an environment variable

```bash
export ACRUXCORE_API_KEY="<paste your key>"
# Hosted: https://api.acruxcore.com/api/v1 · Local dev: http://localhost:3001/api/v1
export ACRUXCORE_BASE_URL="https://api.acruxcore.com/api/v1"
```

## 3. Send it on every request

```bash
curl -H "Authorization: Bearer $ACRUXCORE_API_KEY" "$ACRUXCORE_BASE_URL/prompts"
```

Every curl example in this reference uses `$ACRUXCORE_API_KEY` and
`$ACRUXCORE_BASE_URL` this same way — set the two variables once per shell
session and every example below is copy-pasteable as-is.

:::note[A few endpoints are dashboard-only, not API-key]
Signing up, logging in, and team/member management (invites, roles) happen
through a browser session, not a Bearer token — there's no practical reason to
script them, so they aren't documented here. Creating, editing, and deleting a
**prompt** are also dashboard-session-only today (see the note on the
[Prompts](/api-reference/prompts) page) — read, search, and version endpoints work
fine with your Bearer key.
:::

## What's next

- [Quickstart](/docs/getting-started/quickstart) walks through creating an
  account, a key, a model, and a prompt end to end.
- [Prompts](/api-reference/prompts) — read, search, and resolve prompts.
- [Gateway](/api-reference/gateway) — call the LLM gateway.
- [Traces](/api-reference/traces) — inspect what the gateway recorded.
