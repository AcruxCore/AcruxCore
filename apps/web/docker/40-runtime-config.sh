#!/bin/sh
# Writes /runtime-config.js from the container's environment, so the published
# web image carries no install's Sentry DSN or GA4 ID inside its bundle. The
# official nginx image runs every executable *.sh in /docker-entrypoint.d/
# before nginx starts; src/lib/runtime-config.ts reads what this file sets.
#
# Each value is checked against the characters a real one can contain before
# it is written into JavaScript. A value that fails is dropped with a warning,
# so a stray quote in .env turns the feature off instead of breaking the page.
set -eu

out=/usr/share/nginx/html/runtime-config.js

dsn="${SENTRY_WEB_DSN:-}"
if [ -n "$dsn" ] && ! printf '%s' "$dsn" | grep -Eq '^https://[A-Za-z0-9@:/._-]+$'; then
  echo "runtime-config: SENTRY_WEB_DSN is not a https URL of plain characters; browser error reporting is off" >&2
  dsn=""
fi

ga4="${GA4_MEASUREMENT_ID:-}"
if [ -n "$ga4" ] && ! printf '%s' "$ga4" | grep -Eq '^G-[A-Z0-9]+$'; then
  echo "runtime-config: GA4_MEASUREMENT_ID is not of the form G-XXXXXXXXXX; analytics is off" >&2
  ga4=""
fi

printf 'window.__ACRUXCORE_CONFIG__ = {"sentryWebDsn":"%s","ga4MeasurementId":"%s"};\n' "$dsn" "$ga4" > "$out"
