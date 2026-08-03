# Teams API

> All endpoints require authentication (session cookie or Bearer API key where applicable).
> Team management routes (member, invite, team-key management) require a session; they block team-scoped keys with `TEAM_KEY_NOT_PERMITTED`.

---

## Members

### GET /api/v1/teams/:id/members

Returns all current members of the team with their role and join date. A
member holds exactly one role.

```bash
curl -b cookies.txt $ACRUXCORE_BASE_URL/teams/73e9f801-9f43-412f-a359-4d23928b9eff/members
```

Response (status 200):

```json
[
  {
    "userId": "00cc9833-13ca-42b4-a102-b403e85ea250",
    "email": "demo@acruxcore.com",
    "role": "owner",
    "joinedAt": "2026-07-27T16:28:38.265Z"
  },
  {
    "userId": "b7645f3b-e573-4841-b3ac-1ca05c0be310",
    "email": "viewer-demo@acruxcore.com",
    "role": "viewer",
    "joinedAt": "2026-07-28T20:05:58.900Z"
  }
]
```

### PATCH /api/v1/teams/:id/members/:userId/roles

Replaces a member's role. Requires `owner` or `admin` role. The `owner` role cannot be granted via this endpoint.

```bash
curl -b cookies.txt -X PATCH \
  $ACRUXCORE_BASE_URL/teams/73e9f801-9f43-412f-a359-4d23928b9eff/members/b7645f3b-e573-4841-b3ac-1ca05c0be310/roles \
  -H "Content-Type: application/json" \
  -d '{"role":"viewer"}'
```

Response (status 200):

```json
{
  "userId": "b7645f3b-e573-4841-b3ac-1ca05c0be310",
  "role": "viewer"
}
```

Member not found (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Member not found." } }
```

### DELETE /api/v1/teams/:id/members/:userId

Removes a member from the team. Requires `owner` or `admin`. Cannot remove the last owner.

```bash
curl -b cookies.txt -X DELETE \
  $ACRUXCORE_BASE_URL/teams/6b934e69-830a-405f-9f93-a5f2e30f1137/members/076ddf54-7560-4e6b-8ed7-87eede02246b
```

Response (status 204) — no body.

Removing last owner (status 403):

```json
{ "error": { "code": "LAST_OWNER", "message": "Cannot remove the last owner of a team." } }
```

---

## Invites

### POST /api/v1/teams/:id/invites

Creates a new 7-day invite link for a single role. Requires `owner` or `admin`.

`email` is optional. Omit it for the copy-link path — the endpoint only creates
the invite row and returns the token for you to share yourself. Pass `email` to
also send the invite by mail (via the SES-backed email queue); the response is
identical either way, just with `email` populated instead of `null`.

```bash
curl -b cookies.txt -X POST \
  $ACRUXCORE_BASE_URL/teams/73e9f801-9f43-412f-a359-4d23928b9eff/invites \
  -H "Content-Type: application/json" \
  -d '{"role":"editor","email":"teammate@example.com"}'
```

Response (status 201):

```json
{
  "id": "896b0998-c94f-4ee6-8027-173da06d2f35",
  "token": "<invite-token>",
  "role": "editor",
  "email": "teammate@example.com",
  "expiresAt": "2026-08-05T13:57:11.475Z",
  "createdAt": "2026-07-29T13:57:11.476Z"
}
```

Omitting `email` returns `"email": null` and sends nothing:

```json
{
  "id": "9d44149a-ff26-4de5-97b4-b9a016454bb4",
  "token": "<invite-token>",
  "role": "viewer",
  "email": null,
  "expiresAt": "2026-08-01T15:53:30.546Z",
  "createdAt": "2026-07-25T15:53:30.547Z"
}
```

A team that has already sent 20 invite emails in the trailing hour gets a
`429` on any further emailed invite — this only applies when `email` is
present; the copy-link path is never rate-limited:

```json
{ "error": { "code": "EMAIL_RATE_LIMITED", "message": "This team has sent 20 invite emails in the last hour. Try again later or share the link directly." } }
```

### GET /api/v1/teams/:id/invites

Lists all pending (unused, unexpired) invites. Requires `owner` or `admin`.

```bash
curl -b cookies.txt $ACRUXCORE_BASE_URL/teams/6b934e69-830a-405f-9f93-a5f2e30f1137/invites
```

Response (status 200):

```json
[
  {
    "id": "54f52328-5058-4043-bd0e-3afbd3a0acf2",
    "token": "<invite-token>",
    "role": "editor",
    "invitedBy": "b6f9af51-50af-4a9f-a3a0-ee4658a1b7ff",
    "email": "teammate@example.com",
    "expiresAt": "2026-08-01T15:53:00.793Z",
    "createdAt": "2026-07-25T15:53:00.793Z"
  }
]
```

### POST /api/v1/teams/invites/:token/accept

Accepts an invite. The authenticated user joins the team with the invite's role.

```bash
curl -b cookies.txt -X POST \
  "$ACRUXCORE_BASE_URL/teams/invites/REPLACE_WITH_YOUR_INVITE_TOKEN/accept"
```

Response (status 200):

```json
{
  "team": {
    "id": "6b934e69-830a-405f-9f93-a5f2e30f1137",
    "name": "b6owner@example.com's team"
  }
}
```

Invite already used (status 410):

```json
{ "error": { "code": "INVITE_USED", "message": "This invite has already been used." } }
```

Already a member (status 409):

```json
{ "error": { "code": "ALREADY_MEMBER", "message": "You are already a member of this team." } }
```

Unknown or expired token (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Invite not found." } }
```

### DELETE /api/v1/teams/:id/invites/:inviteId

Revokes (hard-deletes) a pending invite. Requires `owner` or `admin`.

```bash
curl -b cookies.txt -X DELETE \
  "$ACRUXCORE_BASE_URL/teams/6b934e69-830a-405f-9f93-a5f2e30f1137/invites/08fe21ef-346b-40db-9469-8ddde3b271c4"
```

Response (status 204) — no body.

Unknown invite (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "Invite not found." } }
```

---

## Team API Keys

Team-scoped API keys authenticate as the team (no user identity). They can read prompts and call the render/versions endpoints but cannot manage members, invites, or create other keys.

### POST /api/v1/teams/:id/api-keys

Creates a team-scoped key. The full key is returned only here. Requires `owner` or `admin`.

```bash
curl -b cookies.txt -X POST \
  $ACRUXCORE_BASE_URL/teams/6b934e69-830a-405f-9f93-a5f2e30f1137/api-keys \
  -H "Content-Type: application/json" \
  -d '{"name":"ci-key"}'
```

Response (status 201):

```json
{
  "id": "b296f5fe-9733-4f35-bc0b-84e6e3c4324d",
  "key": "acx_sk_REPLACE_WITH_YOUR_KEY",
  "name": "ci-key",
  "createdAt": "2026-06-26T23:31:15.340Z"
}
```

### GET /api/v1/teams/:id/api-keys

Lists active team keys (masked, last 4 chars only). Requires `owner` or `admin`.

```bash
curl -b cookies.txt $ACRUXCORE_BASE_URL/teams/6b934e69-830a-405f-9f93-a5f2e30f1137/api-keys
```

Response (status 200):

```json
[
  { "id": "b296f5fe-9733-4f35-bc0b-84e6e3c4324d", "name": "ci-key", "lastFour": "f2a6", "createdAt": "2026-06-26T23:31:15.340Z" }
]
```

### DELETE /api/v1/teams/:id/api-keys/:keyId

Revokes a team key. Requires `owner` or `admin`.

```bash
curl -b cookies.txt -X DELETE \
  $ACRUXCORE_BASE_URL/teams/6b934e69-830a-405f-9f93-a5f2e30f1137/api-keys/b296f5fe-9733-4f35-bc0b-84e6e3c4324d
```

Response (status 204) — no body.

Unknown key (status 404):

```json
{ "error": { "code": "NOT_FOUND", "message": "API key not found." } }
```

---

## RBAC error codes

| Code | Status | Meaning |
|------|--------|---------|
| `FORBIDDEN` | 403 | Authenticated but insufficient role |
| `TEAM_KEY_NOT_PERMITTED` | 403 | Team-scoped key tried a user-only action |
| `LAST_OWNER` | 403 | Tried to remove the last owner |
| `INVITE_USED` | 410 | Invite token already consumed |
| `ALREADY_MEMBER` | 409 | User is already a member of the team |
