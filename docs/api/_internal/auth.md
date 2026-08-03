# Auth API

All endpoints verified working via curl. Document updated only after curl confirmation.

Auth is served by **Better Auth**, mounted under `/api/v1/auth`. Two things
follow from that and explain most of what looks unusual below:

- **A session is an httpOnly cookie**, `better-auth.session_token`, backed by a
  row in `auth_sessions`. Use `-c`/`-b` with curl. Bearer API keys are for the
  rest of the API; they are not accepted here, and a session cookie is not
  accepted on API-key routes.
- **Every request must carry an `Origin` header** matching `APP_URL`. Better
  Auth rejects a missing or `null` origin with `403 MISSING_OR_NULL_ORIGIN` —
  browsers always send one, and `node`'s `fetch` sends `null`, so a script needs
  the header set explicitly.

Set these once per shell:

```bash
export B=http://localhost:3001/api/v1
export O='Origin: http://localhost:5173'   # must equal APP_URL
```

The responses below come from a run with `EMAIL_TRANSPORT=smtp`, which turns
**email verification on**. With `EMAIL_TRANSPORT=none` (self-host, no mail)
accounts are created already verified and signed in immediately — see the
last two sections.

---

### GET /api/v1/auth/capabilities

Which sign-in methods this deployment supports. Unauthenticated: the login and
signup pages read it on first paint, before any session can exist. The web app
renders the Google button only when `google` is true, so an install that
configured no Google credentials shows no button rather than one that fails when
pressed.

```bash
curl -s $B/auth/capabilities
```

```json
# Response (status 200)
{
  "google": false,
  "email_verification_required": true
}
```

`google` is true only when **both** `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` are set. `email_verification_required` follows the mail
transport unless `AUTH_REQUIRE_EMAIL_VERIFICATION` overrides it — it is false
when `EMAIL_TRANSPORT=none`, because no verification mail could ever arrive.

---

### POST /api/v1/auth/sign-up/email

```bash
curl -X POST $B/auth/sign-up/email \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"email":"acx-doc-z57eo@web-library.net","password":"doc-password-123","name":"Doc Tester"}'
```

Response (status 200) — **no `Set-Cookie`**. `token` is `null` because the
session is withheld until the address is confirmed; a verification email is
queued instead:

```json
{
  "token": null,
  "user": {
    "name": "Doc Tester",
    "email": "acx-doc-z57eo@web-library.net",
    "emailVerified": false,
    "image": null,
    "createdAt": "2026-07-25T20:43:32.259Z",
    "updatedAt": "2026-07-25T20:43:32.259Z",
    "id": "2ce0cddb-b02f-4658-af34-7919d7facbb4"
  }
}
```

`name` maps to the `users.display_name` column. The `user.create.after` hook
gives the account its own team and the `owner` role before this response
returns, so `GET /auth/me` works from the first authenticated request.

---

### POST /api/v1/auth/sign-in/email

Before the address is confirmed (status 403):

```bash
curl -X POST $B/auth/sign-in/email \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"email":"acx-doc-z57eo@web-library.net","password":"doc-password-123"}'
```

```json
{ "message": "Email not verified", "code": "EMAIL_NOT_VERIFIED" }
```

After confirmation (status 200), with the session cookie saved to a jar:

```bash
curl -c cookies.txt -X POST $B/auth/sign-in/email \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"email":"acx-doc-z57eo@web-library.net","password":"doc-password-123"}'
```

```
set-cookie: better-auth.session_token=QpY5z78FSzeerujPnMrZfQLL2NihwS4H.g2cfOUe%2B2EsnP6j%2FxhbzF0Tz2h4ix6TTtwtrybVau8Q%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax
```

```json
{
  "redirect": false,
  "token": "QpY5z78FSzeerujPnMrZfQLL2NihwS4H",
  "user": {
    "name": "Doc Tester",
    "email": "acx-doc-z57eo@web-library.net",
    "emailVerified": true,
    "image": null,
    "createdAt": "2026-07-25T20:43:32.259Z",
    "updatedAt": "2026-07-25T20:43:45.384Z",
    "id": "2ce0cddb-b02f-4658-af34-7919d7facbb4"
  }
}
```

Signing in from a device this account has not used before also queues a
`new_sign_in` alert email. The device is fingerprinted as
`sha256(ip|user-agent)` in `known_devices`; the very first device stays silent,
because it is the signup itself.

---

### GET /api/v1/auth/verify-email

The link is emailed, not constructed by hand — the token is a signed JWT
carrying the address, so nothing is stored server-side for it. Following it:

```bash
curl -i "$B/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFjeC1kb2MtejU3ZW9Ad2ViLWxpYnJhcnkubmV0IiwiaWF0IjoxNzg1MDEyMjEyLCJleHAiOjE3ODUwMTU4MTJ9.GJ2bSm_BK_IUaf5X__YRYY8SdCY_Ut-vyxu2QkNRFzo&callbackURL=%2F"
```

Response (status 302) — confirming also signs the person in, so they land in the
app rather than on a login form:

```
location: /
set-cookie: better-auth.session_token=vDUyVng0sGnJRlVS5HCymeSBfxPo9cym.CCJhn%2BfgMISJSxUC068%2Bto0F8EOjIZaSuoCv%2FQqGAdo%3D; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax
```

Without a `callbackURL` the same endpoint answers `200` with a JSON body
instead of redirecting. A `welcome` email is queued from here — not at signup,
because an unconfirmed address may belong to someone who never asked to sign up.

---

### GET /api/v1/auth/me

```bash
curl -b cookies.txt -H "$O" $B/auth/me
```

Response (status 200):

```json
{
  "user": {
    "id": "2ce0cddb-b02f-4658-af34-7919d7facbb4",
    "email": "acx-doc-z57eo@web-library.net",
    "displayName": "Doc Tester"
  },
  "team": {
    "id": "fcb089bc-f07c-404c-8fae-1cb27612adab",
    "name": "acx-doc-z57eo@web-library.net's team"
  },
  "role": "owner"
}
```

With no cookie, or a cookie whose `auth_sessions` row is gone (status 401):

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required." } }
```

---

### GET /api/v1/auth/teams

```bash
curl -b cookies.txt -H "$O" $B/auth/teams
```

Response (status 200) — every team the caller belongs to, with their role in
each, ordered by membership creation ascending (personal team first):

```json
{
  "teams": [
    {
      "id": "fcb089bc-f07c-404c-8fae-1cb27612adab",
      "name": "acx-doc-z57eo@web-library.net's team",
      "role": "owner"
    }
  ]
}
```

---

### POST /api/v1/auth/switch-team

```bash
curl -b cookies.txt -c cookies.txt -X POST $B/auth/switch-team \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"teamId":"fcb089bc-f07c-404c-8fae-1cb27612adab"}'
```

Response (status 200) — me-shaped payload for the new active team. Also persists
this team as the user's `default_team_id`, so a future sign-in prefers it again:

```json
{
  "user": {
    "id": "2ce0cddb-b02f-4658-af34-7919d7facbb4",
    "email": "acx-doc-z57eo@web-library.net",
    "displayName": "Doc Tester"
  },
  "team": {
    "id": "fcb089bc-f07c-404c-8fae-1cb27612adab",
    "name": "acx-doc-z57eo@web-library.net's team"
  },
  "role": "owner"
}
```

Switching to a team the caller is NOT a member of (status 404) — same message
whether the team exists or not, so foreign teams are indistinguishable from
missing ones:

```json
{ "error": { "code": "NOT_FOUND", "message": "Team not found." } }
```

---

### POST /api/v1/auth/sign-out

```bash
curl -b cookies.txt -X POST $B/auth/sign-out -H "$O"
```

Response (status 200):

```json
{ "success": true }
```

This deletes the `auth_sessions` row, so revocation is immediate rather than
waiting out a token's expiry. The same cookie on `GET /auth/me` now returns
`401 UNAUTHORIZED`.

---

### POST /api/v1/auth/request-password-reset

```bash
curl -X POST $B/auth/request-password-reset \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"email":"acx-doc-z57eo@web-library.net","redirectTo":"http://localhost:5173/reset-password"}'
```

Response (status 200):

```json
{
  "status": true,
  "message": "If this email exists in our system, check your email for the reset link"
}
```

An address with **no account** returns the byte-identical response, so this
endpoint cannot be used to discover who has an account:

```bash
curl -X POST $B/auth/request-password-reset \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"email":"nobody-here@web-library.net","redirectTo":"http://localhost:5173/reset-password"}'
```

```json
{
  "status": true,
  "message": "If this email exists in our system, check your email for the reset link"
}
```

---

### POST /api/v1/auth/reset-password

The token comes from the emailed link
(`.../auth/reset-password/<token>?callbackURL=...`) — unlike the verification
token, this one is an opaque value stored in `auth_verifications`.

```bash
curl -X POST $B/auth/reset-password \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"newPassword":"doc-rotated-456","token":"hSptcJ7SNJjxFA3SwKylocK1"}'
```

Response (status 200):

```json
{ "status": true }
```

Reusing the same token (status 400) — the link is single-use:

```json
{ "message": "Invalid token", "code": "INVALID_TOKEN" }
```

A completed reset **deletes every session** for that user and queues a
`password_changed` email. Someone resetting because their account was taken
over would otherwise leave the intruder signed in.

---

## Self-hosting without email

### POST /api/v1/auth/first-run/claim

On an instance with **zero users**, the server prints a one-time claim link on
every boot:

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  acruxcore is not set up yet.                                   │
  │  Open this link to create the first account (owner):            │
  └─────────────────────────────────────────────────────────────────┘

  http://localhost:5173/first-run?token=MTc4NTAxNTg3MjY5NQ.vLiNbEgXdFdnHNthK9OZ2bbBvOLh7IkK63wl4iuycBo

  The link works once and expires in 60 minutes.
  Restart the server to get a new one.
```

The `/first-run` page posts the token back with the account details:

```bash
curl -i -c cookies.txt -X POST $B/auth/first-run/claim \
  -H "Content-Type: application/json" -H "$O" \
  -d '{"token":"MTc4NTAxNTg3MjY5NQ.vLiNbEgXdFdnHNthK9OZ2bbBvOLh7IkK63wl4iuycBo","email":"admin@selfhost.local","password":"selfhost-admin-1","name":"Admin"}'
```

Response (status 201) — also sets a session cookie, so the new owner lands in
the app signed in:

```json
{ "user_id": "fb3e0ae1-95e2-4b64-ac95-2eb61b27424f" }
```

```bash
curl -b cookies.txt -H "$O" $B/auth/me
```

```json
{
  "user": { "id": "fb3e0ae1-95e2-4b64-ac95-2eb61b27424f", "email": "admin@selfhost.local", "displayName": "Admin" },
  "team": { "id": "22af22a9-6d01-4477-82b8-2d3543f1a8a7", "name": "admin@selfhost.local's team" },
  "role": "owner"
}
```

A wrong token, **or the correct token replayed after a successful claim**,
returns the same 403 — nothing is stored to mark the token used, because a
claimed instance has a user and is therefore no longer claimable:

```json
{ "error": { "code": "FORBIDDEN", "message": "This link is no longer valid." } }
```

After the first account exists, further users join by
[team invite](teams.md#invites), whose token works without email.

### Resetting a password with no mail transport

`POST /auth/request-password-reset` still works with `EMAIL_TRANSPORT=none`, but
nothing can deliver the link. Mint it on the server instead:

```bash
npm run reset-password -w @acruxcore/api -- admin@selfhost.local
```

It prints the same single-use, one-hour link the email would have carried. The
flow is otherwise identical, so an intercepted link expires and single-uses the
same way.
