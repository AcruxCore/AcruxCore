# syntax=docker/dockerfile:1
#
# Web image for AcruxCore — builds the React/Vite SPA and serves the static
# output with nginx. nginx also reverse-proxies /api to the `api` service, so
# the browser talks to the API same-origin (no CORS, matching how the Vite dev
# proxy behaves).
#
# Build context MUST be the repo root (see docker-compose.yml) because the web
# app is an npm workspace and shares the root lockfile.
#
# This build takes no build args, so the image is identical for every
# deployment — production runs the same image Docker Hub publishes. The session
# is an httpOnly cookie issued by our own API on this same origin, so the bundle
# embeds no key. SENTRY_WEB_DSN and GA4_MEASUREMENT_ID are read when the
# container starts: docker/40-runtime-config.sh writes them into
# /runtime-config.js, which index.html loads before the app.

# ---------------------------------------------------------------------------
# Stage 1 — build the SPA.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder

WORKDIR /app

# `npm ci` installs every workspace, including the api's native addon
# (isolated-vm), so the compile toolchain must be present here too.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/docs/package.json apps/docs/
COPY packages/sdk/package.json packages/sdk/

RUN npm ci

COPY . .

RUN npx turbo run build --filter=@acruxcore/web

# ---------------------------------------------------------------------------
# Stage 2 — serve with nginx.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS web

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 apps/web/docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
