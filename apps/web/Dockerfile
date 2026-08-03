# syntax=docker/dockerfile:1
#
# Web image for Acrux Core — builds the React/Vite SPA and serves the static
# output with nginx. nginx also reverse-proxies /api to the `api` service, so
# the browser talks to the API same-origin (no CORS, matching how the Vite dev
# proxy behaves).
#
# Build context MUST be the repo root (see docker-compose.yml) because the web
# app is an npm workspace and shares the root lockfile.
#
# This build takes no auth build args. The session is an httpOnly cookie issued
# by our own API on this same origin, so the bundle embeds no key and the image
# is identical for every deployment. It DOES take SENTRY_WEB_DSN and
# GA4_MEASUREMENT_ID: Vite bakes env vars into the static bundle at build time,
# not at container start, so there is no other point at which a static SPA
# image could pick these up.

# ---------------------------------------------------------------------------
# Stage 1 — build the SPA.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder

WORKDIR /app

# `npm ci` installs every workspace, including the api's native addons
# (isolated-vm, bcrypt), so the compile toolchain must be present here too.
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

# Declared right before the build step (not earlier) so changing the DSN
# invalidates only this layer onward, not the `npm ci` layer above it.
# Re-exposed as SENTRY_WEB_DSN/GA4_MEASUREMENT_ID (not VITE_-prefixed names) so
# this Dockerfile uses the same env var names as docker-compose.yml/.env
# everywhere else; vite.config.ts's `define` is what maps each onto the
# VITE_-prefixed name the client bundle actually reads.
ARG SENTRY_WEB_DSN
ARG GA4_MEASUREMENT_ID
ENV SENTRY_WEB_DSN=$SENTRY_WEB_DSN
ENV GA4_MEASUREMENT_ID=$GA4_MEASUREMENT_ID

RUN npx turbo run build --filter=@acruxcore/web

# ---------------------------------------------------------------------------
# Stage 2 — serve with nginx.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS web

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
