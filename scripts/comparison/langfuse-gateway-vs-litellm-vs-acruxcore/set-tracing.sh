#!/usr/bin/env bash
# Switch all three gateways to one tracing setting before a latency run.
#
#   ./set-tracing.sh off       Langfuse NONE,  LiteLLM no callback,      AcruxCore payloads off
#   ./set-tracing.sh defaults  Langfuse USAGE, LiteLLM no callback,      AcruxCore payloads on
#   ./set-tracing.sh full      Langfuse FULL,  LiteLLM Langfuse callback, AcruxCore payloads on
#
# AcruxCore has no "off": every gateway call writes a trace, and the team
# setting only decides whether the trace stores the request and response.
#
# Langfuse's ingestion mode is an organization setting with no public API.
# This script calls the same internal route the dashboard's AI Gateway page
# uses (aiGateway.updateConfig), signed in with the dashboard user.
#
# Needs: ACRUXCORE_KEY and OPENAI_API_KEY, plus LF_ORG, LF_PROJECT_ID,
# LF_EMAIL and LF_PASSWORD for the Langfuse org. Run from this folder.
set -euo pipefail

mode="${1:?usage: set-tracing.sh off|defaults|full}"
case "$mode" in
  off)      lf=NONE;  litellm=config.yaml;          payloads=false ;;
  defaults) lf=USAGE; litellm=config.yaml;          payloads=true ;;
  full)     lf=FULL;  litellm=config.langfuse.yaml; payloads=true ;;
  *) echo "unknown mode $mode" >&2; exit 1 ;;
esac

LF=${LANGFUSE_URL:-http://localhost:3000}
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
csrf=$(curl -s -c "$jar" "$LF/api/auth/csrf" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')
curl -s -b "$jar" -c "$jar" -o /dev/null -X POST "$LF/api/auth/callback/credentials" \
  --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$LF_EMAIL" \
  --data-urlencode "password=$LF_PASSWORD" -d json=true
curl -s -b "$jar" -o /dev/null -w "langfuse ingestionMode=$lf -> %{http_code}\n" \
  -X POST "$LF/api/trpc/aiGateway.updateConfig" -H 'Content-Type: application/json' \
  -d "{\"json\":{\"orgId\":\"$LF_ORG\",\"defaultIngestionProjectId\":\"$LF_PROJECT_ID\",\"ingestionMode\":\"$lf\"}}"

LITELLM_CONFIG=$litellm docker compose -f litellm/docker-compose.yml up -d --force-recreate litellm 2>/dev/null
until curl -sf http://localhost:4000/health/liveliness >/dev/null; do sleep 1; done
echo "litellm config=$litellm"

curl -s -o /dev/null -w "acruxcore capturePayloads=$payloads -> %{http_code}\n" \
  -X PUT "${ACRUXCORE_BASE_URL:-http://localhost:3097/api/v1}/traces/settings" \
  -H "Authorization: Bearer $ACRUXCORE_KEY" -H 'Content-Type: application/json' \
  -d "{\"capturePayloads\": $payloads}"

# The Langfuse gateway caches key resolution, and with it the ingestion mode,
# for 60 seconds. Wait it out so the first measured round uses the new mode.
echo "waiting 70 s for the Langfuse gateway cache"
sleep 70
