#!/usr/bin/env bash
# Convenience runner for a local, unreleased-SDK checkout. Not part of the shipped
# scripts — those import `@acruxcoreai/sdk` / `acruxcore` normally, as a reader would.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$HERE/../../.." && pwd)"
REPO="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir | xargs dirname)"

export ACRUXCORE_API_KEY="${ACRUXCORE_API_KEY:-$(grep -E '^ACRUXCORE_API_KEY=' "$REPO/.env" | cut -d= -f2-)}"
export ACRUXCORE_BASE_URL="${ACRUXCORE_BASE_URL:-http://localhost:3011/api/v1}"
export MODEL="${MODEL:-gpt-4o-mini}"

case "${1:-}" in
  node-1)   cd "$HERE/node"   && node 01-system-prompt-in-code.mjs ${2+"$2"} ;;
  node-2)   cd "$HERE/node"   && node 02-stored-prompt-no-placeholders.mjs ;;
  node-3)   cd "$HERE/node"   && node 03-live-user-turn-no-variables.mjs ${2+"$2"} ;;
  node-4)   cd "$HERE/node"   && node 04-live-user-turn-with-variables.mjs ${2+"$2"} ;;
  py-1)     cd "$HERE/python" && PYTHONPATH="$WT/packages/sdk-python/src" python3 01_system_prompt_in_code.py ${2+"$2"} ;;
  py-2)     cd "$HERE/python" && PYTHONPATH="$WT/packages/sdk-python/src" python3 02_stored_prompt_no_placeholders.py ;;
  py-3)     cd "$HERE/python" && PYTHONPATH="$WT/packages/sdk-python/src" python3 03_live_user_turn_no_variables.py ${2+"$2"} ;;
  py-4)     cd "$HERE/python" && PYTHONPATH="$WT/packages/sdk-python/src" python3 04_live_user_turn_with_variables.py ${2+"$2"} ;;
  *) echo "usage: ./run.sh {node-1..4|py-1..4} [question]" >&2; exit 2 ;;
esac
