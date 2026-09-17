# syntax=docker/dockerfile:1
#
# Images for AcruxCore — builds the whole npm-workspaces monorepo once in a
# shared `builder` stage, then exposes runtime targets that reuse it:
#   * target `api`    → the Express API (runs prisma migrate deploy, then serves)
#   * target `worker` → the BullMQ eval worker
#
# The docs site (apps/docs) no longer has a Docker target — it deploys as a
# static build straight to Cloudflare Pages via .github/workflows/docs.yml,
# not as a container (see cross-cutting-faq.md, "Docs hosting" entry).
#
# The web app has its own Dockerfile (apps/web/Dockerfile) because it ships as
# static files behind nginx, not a Node process.
#
# Build context MUST be the repo root (see docker-compose.yml) so the builder
# can see every workspace package.

# ---------------------------------------------------------------------------
# Stage 1 — builder: install all workspace deps and compile api + worker.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder

WORKDIR /app

# isolated-vm is a native addon compiled during `npm ci`, so the toolchain
# (python3 + make + g++) must be present before install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/docs/package.json apps/docs/
COPY packages/sdk/package.json packages/sdk/

RUN npm ci

# Now the rest of the source (node_modules/dist/.env excluded via .dockerignore).
COPY . .

# Generate the Prisma client, then build the api and the worker (turbo orders
# api before worker because the worker declares it as a workspace dependency).
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma
RUN npx turbo run build --filter=@acruxcore/api --filter=@acruxcore/worker

# Everything above needs the full toolchain — typescript, turbo, the Docusaurus
# and Vite chains that apps/docs and apps/web pull in. None of it belongs in a
# container that only runs `node dist/server.js`, where a compiler and a test
# runner are attack surface rather than tools.
#
# `npm ci` always wipes node_modules first, so re-running it here with
# --omit=dev and only the two runtime workspaces replaces the tree rather than
# pruning it: apps/web and apps/docs are not selected, so their whole
# dependency chains disappear instead of surviving as production deps. The
# explicit rm covers the per-workspace node_modules directories npm leaves
# behind when a workspace is deselected.
#
# The Prisma client has to be generated again afterwards: it lives under
# node_modules/.prisma, which the install just deleted, and the server cannot
# start without it. dist/ is untouched by an install, so the build above stands.
#
# `prisma` itself moved from apps/api devDependencies to dependencies in the
# same commit. docker-entrypoint.sh runs `prisma migrate deploy` on every boot,
# so the CLI is a runtime dependency in fact; saying so is what lets this line
# be --omit=dev at all.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && npm ci --omit=dev \
       --workspace=@acruxcore/api \
       --workspace=@acruxcore/worker \
       --include-workspace-root \
  && npx prisma generate --schema=apps/api/prisma/schema.prisma

# ---------------------------------------------------------------------------
# Stage 2 — api runtime.
# ---------------------------------------------------------------------------
# Same Debian base as the builder so the compiled native addon (isolated-vm)
# and the Prisma engines stay ABI-compatible. The whole /app tree is
# copied so the workspace symlinks (node_modules/@acruxcore/* → apps/*) and the
# Prisma CLI needed by `migrate deploy` come along intact.
FROM node:22-bookworm AS api

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

EXPOSE 3001

# migrate deploy runs on every boot, then the server starts. See the script.
CMD ["sh", "/app/apps/api/docker-entrypoint.sh"]

# ---------------------------------------------------------------------------
# Stage 3 — worker runtime.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS worker

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

CMD ["node", "apps/worker/dist/index.js"]
