#!/usr/bin/env bash
#
# Call a prompt's tools with no SDK -- the prompt-reference body, streamed.
#
# The gateway renders the prompt, auto-attaches its bound tools, and streams the
# result in one request. Definitions only: the model's tool calls come back as SSE
# fragments and NOTHING is executed for you. Reach for this from a language with no
# AcruxCore SDK.
#
# Env:
#   ACRUXCORE_API_KEY   -- required
#   ACRUXCORE_BASE_URL  -- required (e.g. http://localhost:3001/api/v1)
#   PROMPT_NAME         -- default "weather-brief"
#   PROMPT_ALIAS        -- default "production"
#   CITY                -- default "Lisbon"
#   MODEL               -- default "gpt-4o-mini"
#
# Run:
#   ./stream_prompt_tools.sh
set -euo pipefail

: "${ACRUXCORE_API_KEY:?set ACRUXCORE_API_KEY}"
: "${ACRUXCORE_BASE_URL:?set ACRUXCORE_BASE_URL (e.g. http://localhost:3001/api/v1)}"
PROMPT_NAME="${PROMPT_NAME:-weather-brief}"
PROMPT_ALIAS="${PROMPT_ALIAS:-production}"
CITY="${CITY:-Lisbon}"
MODEL="${MODEL:-gpt-4o-mini}"

echo "=== 1. What the prompt resolves to (render) ==="
curl -sS -X POST "$ACRUXCORE_BASE_URL/prompts/$PROMPT_NAME/$PROMPT_ALIAS/render" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"variables\":{\"city\":\"$CITY\"}}"
echo

echo
echo "=== 2. Streamed, with the prompt's tools auto-attached ==="
# `-N` disables curl's output buffering, so frames print as they arrive rather
# than all at once when the stream closes.
curl -sS -N -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{
        \"model\": \"$MODEL\",
        \"prompt\": {\"name\": \"$PROMPT_NAME\", \"alias\": \"$PROMPT_ALIAS\", \"variables\": {\"city\": \"$CITY\"}},
        \"stream\": true
      }"

echo
echo
echo "Note: the tool_calls above arrived as fragments and were NOT executed."
echo "Accumulate them by their \`index\`, run the tool yourself, then send a second"
echo "request with the tool result appended as a {\"role\":\"tool\"} message --"
echo "or let run_prompt_with_tools() do all of that (see the Python/TypeScript scripts)."
