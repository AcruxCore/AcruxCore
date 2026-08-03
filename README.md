# acruxcore

A multi-tenant agentic platform, built in phases (Prompt Management → AI Gateway →
Tracing → Tool Catalog → Evaluation → Agentic Platform). This is an **npm
workspaces monorepo** orchestrated with **Turborepo**. The hosted product is at
[acruxcore.com](https://acruxcore.com).

This is the public source for Acrux Core, mirrored here from every deploy to
production. Licensed under [Elastic License 2.0](./LICENSE). The AcruxCore name and
logo are protected separately — see [TRADEMARK.md](./TRADEMARK.md).

Contributions welcome — see [CLA.md](./CLA.md) before opening a pull request.

`packages/sdk` and `packages/sdk-python` ship under their own **MIT** license,
standard for published client libraries — the root Elastic License 2.0 covers
the platform itself, not the SDKs.

```
apps/
  api/   → Express + TypeScript API (port 3001)
  web/   → React + Vite frontend    (port 5173, proxies /api → :3001)
packages/, services/  → shared code + future sidecars
```

The design docs live under `docs/superpowers/specs/`; the living API reference is
in `docs/api/`.

---

## Prerequisites

- **Node.js ≥ 20** and **npm 10** (`npm@10.8.2` is the pinned package manager).
- **PostgreSQL** running locally. The quickest way is Docker:

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

Run these once from the repo root.

**1. Install all workspace dependencies** (one command installs api + web):

```bash
npm install
```

**2. Create the API environment file** and fill in the secrets:

```bash
cp apps/api/.env.example apps/api/.env
```

Then edit `apps/api/.env`:

- `DATABASE_URL` — your Postgres connection string (the default matches the Docker
  command above: `postgres://postgres:postgres@localhost:5432/acruxcore`).
- `GATEWAY_ENCRYPTION_KEY` — the AES key that encrypts stored provider keys, must be
  a base64-encoded 32 bytes: `openssl rand -base64 32`.
- `PORT` — leave at `3001` (the web dev proxy points here).
- **Supabase** (`SUPABASE_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) — auth is handled by Supabase;
  the API verifies the JWT sent as `Authorization: Bearer <jwt>`. Point these at a
  **real Supabase project** to exercise browser login locally (the API verifies
  that project's JWTs against its JWKS). You only get to skip Supabase entirely for
  the **test suite**, which mints its own JWTs offline (see Tests).
- `DIRECT_URL` — the **direct, non-pooled** Postgres connection Prisma Migrate uses.
  Against hosted Supabase, `DATABASE_URL` is the **pooled** url
  (`...pooler.supabase.com:6543`, `?pgbouncer=true`) used by the app at runtime,
  while `DIRECT_URL` is the direct `:5432` connection migrations run against. For
  **local Postgres both point at the same local database** (leave `DIRECT_URL` unset).

**3. Create the web environment file** (browser Supabase client):

```bash
cp apps/web/.env.example apps/web/.env
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from your Supabase project
(Project Settings → API). These power the browser Supabase client that handles
signup, login, Google OAuth, and password reset.

**4. Create the database and apply migrations** (needs Postgres already running):

```bash
npm run db:setup -w @acruxcore/api
```

`db:setup` branches on the DB host: for a **Supabase** host (`supabase.co` /
`supabase.com`) it skips `CREATE DATABASE` and migrates via `DIRECT_URL`; for
**local Postgres** it creates the `acruxcore` database if missing, then runs all
Prisma migrations. Re-run it any time you pull new migrations.

---

## Running the app

**Run backend + frontend together** (Turborepo starts both in one terminal):

```bash
npm run dev
```

- API → http://localhost:3001 (routes under `/api/v1`)
- Web → **http://localhost:5173** ← open this in your browser

Both ports come from the repo's root `.env` (`API_PORT`, `WEB_PORT`); the frontend
proxies `/api` to the backend, so they share an origin without extra CORS config.

**Or run them separately** (two terminals) — handy when you only touch one side:

```bash
# backend only (hot-reloads on save via tsx watch)
npm run dev -w @acruxcore/api

# frontend only
npm run dev -w @acruxcore/web
```

To sign in, open the web app and use the **Sign up** page. Auth runs through
Supabase (email/password, Google OAuth, password reset) directly from the browser;
the browser obtains a JWT and sends it to the API as `Authorization: Bearer <jwt>`.
The API verifies that token and find-or-creates the local user/team on first request.

---

## Run with Docker

A Compose stack runs the API, the eval worker, the web app, and the public docs
site (both served by nginx) in containers, plus Redis for the worker queue. The
**database and auth come from Supabase** — the containers connect to your
Supabase Postgres, so no local Postgres runs here. Only Docker is needed on the
host.

```bash
# 1. Create your env from the template and fill in the required values
cp .env.docker.example .env

# 2. Generate the gateway encryption key and paste it into .env
openssl rand -base64 32   # → GATEWAY_ENCRYPTION_KEY=...

# 3. Set DATABASE_URL / DIRECT_URL (Supabase) and the Supabase auth values in .env

# 4. Build and start everything
docker compose up --build
```

- Web → **http://localhost:5173**
- API → http://localhost:3001 (routes under `/api/v1`)
- Docs → **http://localhost:3100** (public Docusaurus site)

Redis runs as a container for the worker queue; Postgres and auth come from
Supabase. The API applies pending migrations on boot. The `VITE_*` Supabase
values are baked in at build time, so re-run `docker compose build web` after
changing them.

Stop the stack with `docker compose down`.

---

## Tests

Backend tests run against a **real Postgres test database** (no mocks). Create it
once and point `TEST_DATABASE_URL` at it in `apps/api/.env`:

```bash
# create the test DB
docker exec postgres createdb -U postgres acruxcore_test
# add to apps/api/.env
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/acruxcore_test
# apply migrations to it (run from apps/api)
cd apps/api && DATABASE_URL="postgres://postgres:postgres@localhost:5432/acruxcore_test" npx prisma migrate deploy
```

Then:

```bash
npm test                                     # all workspaces (jest --runInBand)
npm test -w @acruxcore/api            # backend only
npm run typecheck -w @acruxcore/web   # frontend type check
```

Tests run entirely offline against **local Postgres** — no real Supabase needed.
The test-auth helper generates an RS256 keypair at runtime and mints valid
Supabase-format JWTs locally, so auth is exercised end-to-end without any network.
Local Postgres is used for both dev and tests; Supabase cloud is production-only.

Live provider tests (real OpenAI/Anthropic/Gemini calls) are **skipped unless** the
matching `OPENAI_TEST_KEY` / `ANTHROPIC_TEST_KEY` / `GEMINI_TEST_KEY` is set in
`apps/api/.env`.

---

## Docs site

The public docs site (`apps/docs`) is a separate Docusaurus workspace — it does
not run as part of `npm run dev`.

```bash
npm run start -w @acruxcore/docs
```

- Docs → **http://localhost:3100**

To check the production build (also required before opening a docs PR):

```bash
npm run build -w @acruxcore/docs
```

---

## Production build

```bash
npm run build                        # builds every workspace
npm start -w @acruxcore/api   # serve the compiled API from dist/
```

The web build (`apps/web`) emits static assets to `apps/web/dist`.

---

## Troubleshooting

- **`EADDRINUSE :3001`** — another process holds the API port. Stop it, or set a
  different `PORT` in `apps/api/.env` **and** update the proxy `target` in
  `apps/web/vite.config.ts` to match.
- **API exits on start complaining about the encryption key** — `GATEWAY_ENCRYPTION_KEY`
  is missing or not a base64 32-byte value. Regenerate with `openssl rand -base64 32`.
- **DB connection refused** — Postgres isn't running, or `DATABASE_URL` is wrong.
- **Tests error about `TEST_DATABASE_URL`** — see the Tests section above; the test
  DB is separate from the dev DB.
