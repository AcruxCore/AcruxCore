#!/bin/sh
# Entrypoint for the API container.
#
# Applies any pending Prisma migrations against the configured database, then
# starts the Express server. `migrate deploy` is idempotent — it only runs
# migrations that have not been applied yet — so it is safe on every boot.
set -e

echo "[api] Applying database migrations (prisma migrate deploy)..."
npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma

echo "[api] Starting server..."
exec node apps/api/dist/server.js
