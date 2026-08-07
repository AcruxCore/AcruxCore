# Contributing to AcruxCore

Thanks for considering a contribution to AcruxCore — this guide covers everything
from a first-time source checkout to how to submit a change.

If you'd rather just *run* AcruxCore than build it, see the
[Self-hosting](./README.md#-self-hosting) section of the main README instead —
everything below is for working on the source itself.

## Before you open a pull request

- **Small fix** (a bug, a typo, a small doc improvement) — just open the PR.
- **Anything bigger** (a new feature, a schema or API change, a redesign) — open an
  issue first so we can agree on the approach before you put in the work.
- **Sign the CLA.** Every contribution is covered by the
  [Individual Contributor License Agreement](./CLA.md) — you keep ownership of your
  code, you're just granting us a license to use it. Read it before your first PR.
- This GitHub repo is a mirror of what ships to production, and only has one branch,
  `main`. Fork it, branch from `main`, and open your pull request against `main`.
- We loosely follow [Conventional Commits](https://www.conventionalcommits.org) for
  commit messages and PR titles — `feat: …`, `fix: …`, `docs: …`, optionally scoped
  like `feat(web): …`.

## Project layout

This is an **npm workspaces monorepo** orchestrated with **Turborepo**:

```
apps/
  api/   → Express + TypeScript API (port 3001)
  web/   → React + Vite frontend    (port 5173, proxies /api → :3001)
  docs/  → Docusaurus public docs, blog, changelog (port 3100)
  worker/ → BullMQ job runner (eval runs, email, weekly digest)
packages/
  sdk/         → @acruxcoreai/sdk (TypeScript, published to npm)
  sdk-python/  → acruxcore (async Python, published to PyPI)
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
- `BETTER_AUTH_SECRET` — signs session cookies. Auth is in-app (Better Auth): accounts,
  sessions and password hashes all live in your own Postgres, there is no vendor
  project to create. Outside production a fixed dev value is used automatically, so
  local dev needs **nothing here at all**; only set it to keep sessions valid across
  restarts.
- `DIRECT_URL` — the **direct, non-pooled** Postgres connection Prisma Migrate uses.
  Against a pooled host (`?pgbouncer=true`, e.g. Supabase-as-DB or Neon), `DATABASE_URL`
  is the pooled url the app uses at runtime while `DIRECT_URL` is the direct `:5432`
  connection migrations run against. For **local Postgres both point at the same local
  database** (leave `DIRECT_URL` unset).

**3. The web environment file is optional.** `apps/web/.env.example` only has dev-server
port overrides — the dashboard needs no auth configuration at all, since it calls the API
on its own origin and the session is a plain httpOnly cookie. Skip this step unless you
need a non-default port.

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

To sign in, open the web app and use the **Sign up** page (or, on a fresh database
with zero users, the API logs a one-time first-run claim link on boot instead).
Auth is in-app (Better Auth): the browser gets a plain httpOnly session cookie from
our own API on the same origin — no vendor project, no JWT to forward by hand.

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
