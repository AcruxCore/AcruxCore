#!/usr/bin/env bash
# Medical-information QA agent -- bash + curl + jq + awk, gateway, manual tool_calls loop.
#
# Phase 1: render the prompt (tools attached), loop tool_calls by hand until the
#          model stops calling tools -- gathers grounding facts via the real
#          token-overlap search + fixture lookups (implemented in awk/jq below,
#          same logic as the Python/Node tabs).
# Phase 2: SAME trace, one more call with response_format set and NO tools, to
#          shape the final typed MedicalInformationAnswer JSON.
set -euo pipefail

QUESTION="${1:-What is Cortiblex approved to treat, and is it safe for someone with a fungal infection?}"
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../data" && pwd)"
STOPWORDS=" a an and any for in is it of on or the to with "

now() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }

# Lowercase, alnum-only tokens, length > 2, stopwords removed, deduped+sorted.
_tokens() {
  echo "$1" | tr 'A-Z' 'a-z' | grep -oE '[a-z0-9]+' | while read -r w; do
    if [ "${#w}" -gt 2 ] && [[ "$STOPWORDS" != *" $w "* ]]; then echo "$w"; fi
  done | sort -u
}

# Splits each markdown fixture into '## '-delimited sections, one JSON object per line.
_load_sections() {
  for f in "$@"; do
    awk -v file="$f" '
      function slugify(s,   r) { r = tolower(s); gsub(/[^a-z0-9]+/, "-", r); gsub(/^-+|-+$/, "", r); return r }
      function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\n/, "\\n", s); return s }
      function emit() { gsub(/\n+$/, "", body); printf "{\"file\":\"%s\",\"heading\":\"%s\",\"slug\":\"%s\",\"body\":\"%s\"}\n", file, esc(heading), slugify(heading), esc(body) }
      BEGIN { started = 0 }
      /^## / { if (started) emit(); heading = substr($0, 4); body = ""; started = 1; next }
      started { body = body $0 "\n" }
      END { if (started) emit() }
    ' "$DATA_DIR/$f"
  done
}

get_drug_profile() {
  local q_lower; q_lower=$(echo "$1" | tr '[:upper:]' '[:lower:]')
  jq -c --arg q "$q_lower" '[.[] | select((.id|ascii_downcase)==$q or (.brand_name|ascii_downcase)==$q or (.generic_name|ascii_downcase)==$q)] | first // {error:"No drug found"}' "$DATA_DIR/drugs.json"
}

get_inquiry() {
  local id_lower; id_lower=$(echo "$1" | tr '[:upper:]' '[:lower:]')
  jq -c --arg id "$id_lower" '[.[] | select((.id|ascii_downcase)==$id)] | first // {error:"No inquiry found"}' "$DATA_DIR/inquiries.json"
}

search_prescribing_info() {
  local query="$1" q_tokens; q_tokens=$(_tokens "$query")
  _load_sections "neuravex-pi.md" "cortiblex-pi.md" "safety-policy.md" | while IFS= read -r section_json; do
    local heading body s_tokens overlap
    heading=$(echo "$section_json" | jq -r '.heading')
    body=$(echo "$section_json" | jq -r '.body')
    s_tokens=$(_tokens "$heading $body")
    overlap=$(comm -12 <(echo "$q_tokens") <(echo "$s_tokens") | wc -l)
    [ "$overlap" -gt 0 ] && printf '%s\t%s\n' "$overlap" "$section_json"
  done | sort -t $'\t' -k1,1 -rn | head -3 | cut -f2- | jq -s '[.[] | {source: (.file + "#" + .slug), snippet: .body[0:400]}]'
}

check_safety_policy() {
  local topic="$1" slug=""
  case "$topic" in
    response) slug="response-policy" ;;
    refusal) slug="refusal-policy" ;;
    adverse_event) slug="adverse-event-escalation-policy" ;;
    pii) slug="pii-redaction-policy" ;;
    *) jq -n --arg t "$topic" '{error: ("Unknown policy topic " + $t)}'; return ;;
  esac
  _load_sections "safety-policy.md" | jq -c --arg slug "$slug" 'select(.slug == $slug) | {source: ("safety-policy.md#" + $slug), snippet: .body}'
}

run_tool() {
  case "$1" in
    get_drug_profile) get_drug_profile "$(echo "$2" | jq -r '.query')" ;;
    get_inquiry) get_inquiry "$(echo "$2" | jq -r '.inquiry_id')" ;;
    search_prescribing_info) search_prescribing_info "$(echo "$2" | jq -r '.query')" ;;
    check_safety_policy) check_safety_policy "$(echo "$2" | jq -r '.topic')" ;;
    *) echo "Unknown tool: $1" >&2; exit 1 ;;
  esac
}

render_rendered=$(curl -s -X POST "$ACRUXCORE_BASE_URL/prompts/medical-information-qa/production/render" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -Rn --arg q "$QUESTION" '{variables:{question:$q}}')")
messages=$(echo "$render_rendered" | jq -c '.messages')
tools=$(echo "$render_rendered" | jq -c '.tools')
model=$(echo "$render_rendered" | jq -r '.model')

trace_id=""
echo "Question: $QUESTION"

# -- Phase 1: tool-gathering loop --
turn=0
for turn in 1 2 3 4 5; do
  headers_file=$(mktemp)
  if [ -n "$trace_id" ]; then
    response=$(curl -s -D "$headers_file" -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
      -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" -H "x-trace-id: $trace_id" \
      -d "$(jq -n --arg model "$model" --argjson messages "$messages" --argjson tools "$tools" '{model:$model,messages:$messages,tools:$tools}')")
  else
    response=$(curl -s -D "$headers_file" -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
      -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
      -d "$(jq -n --arg model "$model" --argjson messages "$messages" --argjson tools "$tools" '{model:$model,messages:$messages,tools:$tools}')")
  fi
  if [ -z "$trace_id" ]; then
    trace_id=$(grep -i '^x-gateway-trace-id:' "$headers_file" | tr -d '\r' | cut -d' ' -f2)
  fi
  rm -f "$headers_file"

  message=$(echo "$response" | jq -c '.choices[0].message')
  messages=$(echo "$messages" | jq -c --argjson m "$message" '. + [$m]')
  tool_calls=$(echo "$message" | jq -c '.tool_calls // empty')
  if [ -z "$tool_calls" ]; then
    break
  fi

  while IFS= read -r call; do
    [ -z "$call" ] && continue
    call_id=$(echo "$call" | jq -r '.id')
    name=$(echo "$call" | jq -r '.function.name')
    args_json=$(echo "$call" | jq -c '.function.arguments | fromjson')
    started=$(now); result=$(run_tool "$name" "$args_json"); ended=$(now)
    echo "  -> ${name}($(echo "$args_json" | jq -c .))" >&2
    echo "     $(echo "$result" | head -c 200)" >&2
    curl -s -X POST "$ACRUXCORE_BASE_URL/traces" \
      -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
      -d "$(jq -n --arg traceId "$trace_id" --arg spanId "${name}-${started}" --arg name "$name" \
          --arg started "$started" --arg ended "$ended" --argjson args "$args_json" --argjson result "$result" \
          '{traces:[{traceId:$traceId,capturePayloads:true,spans:[{spanId:$spanId,name:$name,kind:"tool",status:"ok",startTime:$started,endTime:$ended,input:$args,output:$result}]}]}')" > /dev/null
    messages=$(echo "$messages" | jq -c --arg cid "$call_id" --arg content "$(echo "$result" | jq -c .)" '. + [{role:"tool", tool_call_id:$cid, content:$content}]')
  done < <(echo "$tool_calls" | jq -c '.[]')
done
echo "(Phase 1: $turn tool round(s), trace $trace_id)" >&2

# -- Phase 2: SAME trace, response_format set, no tools --
ANSWER_SCHEMA='{"type":"object","properties":{"disposition":{"type":"string","enum":["answer","answer_with_limitations","refuse_off_label","refuse_personal_advice","escalate_adverse_event"]},"answer":{"type":"string"},"safety_flags":{"type":"array","items":{"type":"string","enum":["off_label","personal_medical_advice","adverse_event","pii_redacted","unsupported_claim"]}},"escalate_adverse_event":{"type":"boolean"},"pii_redacted":{"type":"boolean"},"redaction_notes":{"type":"array","items":{"type":"string"}},"citations":{"type":"array","items":{"type":"string"}}},"required":["disposition","answer","safety_flags","escalate_adverse_event","pii_redacted","redaction_notes","citations"],"additionalProperties":false}'

last_role=$(echo "$messages" | jq -r '.[-1].role')
last_has_tool_calls=$(echo "$messages" | jq -r '.[-1] | has("tool_calls")')
if [ "$last_role" = "assistant" ] && [ "$last_has_tool_calls" != "true" ]; then
  messages=$(echo "$messages" | jq -c '.[:-1]')
fi
messages=$(echo "$messages" | jq -c '. + [{role:"user",content:"Now produce your final answer as the required MedicalInformationAnswer JSON object only."}]')

final_response=$(curl -s -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" -H "x-trace-id: $trace_id" \
  -d "$(jq -n --arg model "$model" --argjson messages "$messages" --argjson schema "$ANSWER_SCHEMA" \
        '{model:$model,messages:$messages,response_format:{type:"json_schema",json_schema:{name:"medical_information_answer",schema:$schema,strict:true}}}')")

echo "$final_response" | jq -r '.choices[0].message.content' | jq .
