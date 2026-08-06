#!/usr/bin/env bash
set -euo pipefail

: "${ACRUXCORE_API_KEY:?Set ACRUXCORE_API_KEY first}"
: "${ACRUXCORE_BASE_URL:?Set ACRUXCORE_BASE_URL first}"

echo "curl has no decorator equivalent for tools. Create an HTTP tool via the"
echo "dashboard (Gateway -> Tools -> New tool) or POST /tools, then attach it to"
echo "support-reply's next commit -- see build-and-attach-a-tool.mdx or"
echo "store-prompts-and-tools-via-api.mdx. This script picks up from there,"
echo "covering the parts curl can do directly: streaming/non-streaming calls,"
echo "reading the trace id back, and submitting feedback."
echo

HEADERS_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
trap 'rm -f "$HEADERS_FILE" "$BODY_FILE"' EXIT

echo "1. Non-streaming completion"
curl -sD "$HEADERS_FILE" -o "$BODY_FILE" \
  -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "support-model", "messages": [{"role": "user", "content": "Say hi in one word."}]}'
cat "$BODY_FILE"
echo

trace_id=$(grep -i '^x-gateway-trace-id:' "$HEADERS_FILE" | tr -d '\r' | cut -d' ' -f2)
echo "Trace id: $trace_id"
echo

echo "2. Streaming completion (SSE)"
curl -s -N -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "support-model", "stream": true, "messages": [{"role": "user", "content": "Count to three."}]}'
echo

echo "3. Read the trace back"
curl -s "$ACRUXCORE_BASE_URL/traces/$trace_id" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY"
echo

echo "4. Submit feedback on it"
curl -s -X POST "$ACRUXCORE_BASE_URL/traces/$trace_id/feedback" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"rating": 1, "comment": "Weather lookup worked"}'
echo
