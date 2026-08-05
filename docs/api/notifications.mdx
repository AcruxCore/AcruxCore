---
sidebar_position: 13
title: "Notifications"
description: "Read and change which email notifications you receive, per team — plus the unauthenticated one-click unsubscribe endpoints mail clients call."
---

# Notifications API

All endpoints verified working via curl. Document updated only after curl confirmation.

acruxcore sends seven kinds of notification email: two budget alerts (80% used,
and exhausted), evaluation run results, three membership emails (joined, removed,
role changed), and the weekly usage digest. They are grouped into four coarse
**categories**, and each category can be turned off independently.

:::note[Preferences are per team]
A user who belongs to two teams has a separate preference set in each — someone
may care about one team's spend and not the other's. Both endpoints below act on
your **active team**, the one the dashboard's team switcher currently shows.
:::

| Category | Covers |
|---|---|
| `budget_alerts` | The 80% warning and the exhausted notice. Owners/admins only. |
| `eval_runs` | A run you started finishing or failing. |
| `membership` | Someone joining, being removed, or having their role changed. |
| `weekly_digest` | The Monday usage summary. Owners/admins only. |

**No row means enabled.** Nothing is written when you sign up, so a category you
have never touched is on. A new category ships on for everyone until somebody
turns it off.

**One exception:** the *member removed* email ignores preferences entirely.
Losing access to a team is a security-relevant change, so it is always sent.

---

### GET /api/v1/notifications/preferences

Your effective preferences in the active team. Always returns every category, so
a client never has to fill in a missing key.

```bash
curl http://localhost:3001/api/v1/notifications/preferences \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
```

```json
# Response (status 200)
{
  "preferences": {
    "budget_alerts": true,
    "eval_runs": true,
    "membership": true,
    "weekly_digest": true
  }
}
```

Team-scoped API keys are rejected: preferences belong to a person, and a team key
has no user identity.

---

### PATCH /api/v1/notifications/preferences

Turns one category on or off. Returns the full effective map, so the response can
replace client state without a second `GET`.

```bash
curl -X PATCH http://localhost:3001/api/v1/notifications/preferences \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"category":"weekly_digest","enabled":false}'
```

```json
# Response (status 200)
{
  "preferences": {
    "budget_alerts": true,
    "eval_runs": true,
    "membership": true,
    "weekly_digest": false
  }
}
```

Calling it twice for the same category updates the existing row rather than
creating a second one.

An unknown category is a 400:

```bash
curl -X PATCH http://localhost:3001/api/v1/notifications/preferences \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"category":"nope","enabled":false}'
```

```json
# Response (status 400)
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid enum value. Expected 'budget_alerts' | 'eval_runs' | 'membership' | 'weekly_digest', received 'nope'"
  }
}
```

---

## One-click unsubscribe

Every notification email carries an unsubscribe link, and the weekly digest also
sends the RFC 8058 headers Gmail and Yahoo require of bulk senders:

```
List-Unsubscribe: <https://acruxcore.com/api/v1/email/unsubscribe?token=…>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Both endpoints below are **unauthenticated by design** — a mail client POSTs with
no session, and a login prompt would defeat the point. The signed token in the
query string is the entire credential, and it authorizes exactly one action:
turning one category off for one user in one team. It never expires, because an
unsubscribe link in a months-old email must still work.

:::warning[Every response is identical]
A valid token, a tampered token, and a token for a user who has since left the
team all return the same status and body. Distinguishing them would let anyone
enumerate which users belong to which teams. A `POST` also always returns `204`
because mail clients show the recipient an error on any non-2xx — and a token we
mis-signed is not something they can fix.
:::

### POST /api/v1/email/unsubscribe

The one-click target. Idempotent — posting twice leaves one preference row.

```bash
curl -X POST "http://localhost:3001/api/v1/email/unsubscribe?token=Yzc4ZWZhMzgtMjM4Ny00YWE4LWE3Y2ItMjljM2FmZGU0Yjc1OmY1NzY0ZmIxLWU5NDYtNGVhNC05MGRiLTljNmYyNzlkZWNmNjpidWRnZXRfYWxlcnRz.EXAMPLE_SIGNATURE"
```

```
# Response (status 204, no body)
```

A following `GET /api/v1/notifications/preferences` shows the effect:

```json
{
  "preferences": {
    "budget_alerts": false,
    "eval_runs": true,
    "membership": true,
    "weekly_digest": false
  }
}
```

### GET /api/v1/email/unsubscribe

The same action, for the many clients that render `List-Unsubscribe` as a plain
link. Returns a minimal, self-contained confirmation page — no assets, no
tracking, `noindex`.

```bash
curl "http://localhost:3001/api/v1/email/unsubscribe?token=<same token>"
```

```html
<!-- Response (status 200) -->
<!doctype html><html><head><meta charset="utf-8" />…<title>Unsubscribed · acruxcore</title></head>
<body …><div …><h1 …>Unsubscribed</h1>
<p …>You will no longer receive budget alerts for this team.</p>
<p …>You can change this any time from Account &amp; keys in the app. Other notification types are unaffected.</p>
</div></body></html>
```

The token is scoped to **one category in one team**, deliberately. Unsubscribing
from digests does not silently stop your budget alerts, and there is no
account-wide kill switch here — that belongs on the preferences page, where you
are signed in and can see what you are turning off.
