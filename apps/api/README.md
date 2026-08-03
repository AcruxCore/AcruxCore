# `@acruxcore/api`

Express/TypeScript REST API — Phase 1 (Schema, Auth & API Keys).

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 20+ |
| npm | 10+ (workspaces) |
| Docker | any recent |

A PostgreSQL container must be running before you start. If you use the project's Docker setup:

```bash
docker run -d \
  --name postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:18-alpine
```

---

## First-time setup

### 1. Install dependencies (from monorepo root)

```bash
npm install
```

### 2. Configure environment

```bash
cp apps/api/.env.example apps/api/.env
```

The defaults in `.env.example` work out of the box with the Docker container above:

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/acruxcore
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/acruxcore_test
NODE_ENV=development
PORT=3001
```

**Auth (Supabase).** Authentication is handled by Supabase, not this API. The API
only verifies the JWT sent as `Authorization: Bearer <jwt>`. Point these at a **real
Supabase project** to exercise browser login locally (the API verifies that
project's JWTs against its JWKS). Only the **test suite** runs without Supabase — it
mints its own JWTs offline (see [Running tests](#running-tests)):

```
SUPABASE_ISSUER=https://<ref>.supabase.co/auth/v1
SUPABASE_JWKS_URL=https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

**Pooled vs. direct Postgres.** Against hosted Supabase the app runtime connects
through the **pooled** url (`DATABASE_URL`, host `...pooler.supabase.com:6543`,
`?pgbouncer=true`), while Prisma Migrate uses the **direct** url (`DIRECT_URL`,
port `:5432`). For **local Postgres both point at the same local database** — leave
`DIRECT_URL` unset.

> The browser Supabase client lives in `apps/web` and needs its own
> `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in `apps/web/.env`
> (copy `apps/web/.env.example`).

### 3. Create the database and run migrations

One command does everything:

```bash
npm run db:setup -w @acruxcore/api
```

`db:setup` branches on the DB host: for a **Supabase** host (`supabase.co` /
`supabase.com`) it skips `CREATE DATABASE` and migrates via `DIRECT_URL`; for
**local Postgres** it creates the `acruxcore` database if it doesn't exist and
applies all Prisma migrations.

For the local path it connects to `postgres://postgres:postgres@localhost:5432/postgres`
to create the database. If your root connection string is different, override it:

```bash
PG_ROOT_URL=postgres://myuser:mypass@localhost:5432/postgres npm run db:setup -w @acruxcore/api
```

---

## Running the server

```bash
# development (watch mode, auto-restarts on file change)
cd apps/api
npm run dev

# or from the monorepo root (Turborepo)
npm run dev
```

Server starts at **http://localhost:3001** (override with `PORT=` in `.env`).

---

## Running tests

The integration-test philosophy (real HTTP → service → repository → real Postgres,
no mocks) is unchanged. Tests run against **local Postgres** using
`TEST_DATABASE_URL` (a separate `acruxcore_test` database) and need no real
Supabase — the test-auth helper generates an RS256 keypair at runtime and mints
valid Supabase-format JWTs offline, so auth is exercised end-to-end with no network.

```bash
npm test          # runs jest --runInBand
```

Local Postgres backs both dev and tests; Supabase cloud is production-only.

---

## Database migrations

Migrations are managed by **Prisma Migrate**. The schema lives in
`prisma/schema.prisma`; migrations are generated into `prisma/migrations/`.

```bash
cd apps/api

# Create + apply a new migration after editing prisma/schema.prisma
npm run db:migrate          # prisma migrate dev

# Regenerate the Prisma Client (after a schema change)
npm run db:generate         # prisma generate

# Apply already-generated migrations (CI / fresh clone)
npx prisma migrate deploy
```

Never edit a generated `migration.sql` by hand — create a new migration instead.

---

## API Reference

All endpoints are prefixed with `/api/v1`.

Authentication is via **`Authorization: Bearer <token>`** on every protected
endpoint. The token is one of two things:

- A **Supabase JWT** for user/browser sessions — signup, login, Google OAuth, and
  password reset all happen in the browser against Supabase, which returns the JWT.
  The API verifies it against the Supabase JWKS and find-or-creates the local
  user/team keyed on the JWT `sub` claim.
- A **long-lived API key** (`Bearer <key>`) for SDK / programmatic access.

There are no server-side session cookies.

### Error shape

Every error response follows this envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | INTERNAL_ERROR",
    "message": "Human-readable description."
  }
}
```

---

### Auth

Signup, login, Google OAuth, and password reset are **not** API endpoints — the
browser performs them directly against Supabase, which issues a JWT. Send that JWT
as `Authorization: Bearer <jwt>` to the endpoints below; the API verifies it and
find-or-creates the local user/team on first request. The remaining auth endpoints
are `GET /auth/me`, `GET /auth/teams`, and `POST /auth/switch-team`.

#### `GET /api/v1/auth/me`

Returns the authenticated user, their team, and their roles within that team.

```bash
curl http://localhost:3001/api/v1/auth/me \
  -H "Authorization: Bearer <jwt>"
```

**Response `200`**

```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "alice@example.com",
    "displayName": null
  },
  "team": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "name": "alice@example.com's team"
  },
  "roles": ["owner"]
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Missing or invalid `Bearer` token |

---

### API Keys

All API key endpoints require a `Bearer` token — either a Supabase JWT or an API key.

#### `POST /api/v1/api-keys`

Creates a new API key for the authenticated user's team. The full key value is returned **only in this response** — it cannot be retrieved again.

```bash
curl -X POST http://localhost:3001/api/v1/api-keys \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-dev-key"}'
```

**Request body**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | no | Max 100 characters |

**Response `201`**

```json
{
  "id": "a3bb189e-8bf9-3888-9912-ace4e6543002",
  "key": "a1b2c3d4e5f6...64hexchars",
  "name": "my-dev-key",
  "createdAt": "2026-06-23T10:00:00.000Z"
}
```

`key` is 64 hex characters (32 random bytes). Store it securely — this is the only time it is shown.

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Not authenticated |

---

#### `GET /api/v1/api-keys`

Lists all active (non-revoked) API keys for the authenticated user's team. The full key value is never returned — only the last four characters.

```bash
curl http://localhost:3001/api/v1/api-keys \
  -H "Authorization: Bearer <jwt>"
```

**Response `200`**

```json
[
  {
    "id": "a3bb189e-8bf9-3888-9912-ace4e6543002",
    "name": "my-dev-key",
    "lastFour": "3002",
    "createdAt": "2026-06-23T10:00:00.000Z"
  }
]
```

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Not authenticated |

---

#### `DELETE /api/v1/api-keys/:id`

Soft-revokes an API key (sets `revoked_at`). The key immediately stops authenticating requests. You can only revoke keys belonging to your own team.

```bash
curl -X DELETE http://localhost:3001/api/v1/api-keys/a3bb189e-8bf9-3888-9912-ace4e6543002 \
  -H "Authorization: Bearer <jwt>"
```

**Response `204`** — no body.

**Errors**

| Status | Code | When |
|--------|------|------|
| 401 | `UNAUTHORIZED` | Not authenticated |
| 404 | `NOT_FOUND` | Key doesn't exist or belongs to a different team |

---

## Project structure

```
apps/api/
├── src/
│   ├── auth/                  # me, teams, switch-team (Supabase JWT verify + find-or-create)
│   ├── api-keys/              # create, list, revoke
│   └── shared/
│       ├── db/
│       │   ├── client.ts      # single PrismaClient instance
│       │   └── schema.ts      # re-exported Prisma model types
│       ├── middleware/
│       │   ├── error.middleware.ts
│       │   ├── require-auth.middleware.ts
│       │   └── require-api-key.middleware.ts
│       └── errors/            # typed HTTP error classes
├── prisma/
│   ├── schema.prisma          # single source of truth for all models
│   └── migrations/            # Prisma Migrate generated SQL
├── scripts/
│   └── db-setup.ts            # first-time DB bootstrap (npm run db:setup)
├── app.ts                     # Express factory (no listen)
└── server.ts                  # entry point (calls listen)
```

## Database schema (Phase 1)

| Table | Purpose |
|-------|---------|
| `users` | One row per registered user |
| `teams` | Tenancy unit — every user gets a personal team on signup |
| `team_members` | Many-to-many join between users and teams, carrying the one role that member holds (`owner`, `admin`, `editor`, `viewer` — a strict ladder, so one role is enough) |
| `api_keys` | Long-lived Bearer tokens scoped to a user + team |
| `session` | Legacy table from the old express-session auth; no longer used at runtime (auth is now Supabase JWT). Kept in the schema until a migration drops it |
