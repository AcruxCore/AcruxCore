#!/usr/bin/env bash
# Configurable web-research agent — bash + curl + jq, gateway, manual tool_calls loop.
# curl has no runToolLoop() equivalent, so this loops by hand; the Python and Node
# tabs do the same work with run_tool_loop()/runToolLoop().
#
# Flow:
#   1. render  — POST /prompts/web-research-agent/:alias/render (AcruxCore)
#                -> {messages, tools, model, versionId}. Model and system prompt
#                come from whichever ALIAS you pass — that is the whole config swap.
#   2. loop    — POST /gateway/chat/completions. First call sends x-trace-name to
#                open a trace; the response carries x-gateway-trace-id. Every later
#                call sends x-trace-id so all turns land in ONE trace. The gateway
#                records the llm span itself.
#   3. tool    — web_research is a CLIENT tool, so WE run it: a real call to the
#                Tavily REST API, with search_depth/max_results/include_images
#                chosen by ALIAS (mirroring the source's advanced_research/
#                basic_research). We report a `tool` span onto the same trace.
#   4. done    — the model stops asking for tools; print its final answer.
#
# Run:
#   export ACRUXCORE_API_KEY=<your personal api key>
#   export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
#   export TAVILY_API_KEY=tvly-...
#   ./web_research_agent.sh quick "What are people saying about the new Anthropic Claude models?"
#   ./web_research_agent.sh deep  "What are people saying about the new Anthropic Claude models?"
set -euo pipefail

ALIAS="${1:-quick}"
QUESTION="${2:-What are people saying about the new Anthropic Claude models?}"

now() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }

# ── web_research, run locally (client executor — this shell runs it) ─────────
# Same real Tavily REST API (https://api.tavily.com/search) the source's
# TavilySearchResults wraps, called directly since curl has no LangChain.
web_research() {
  local query="$1"
  if [ "$ALIAS" = "quick" ]; then
    # basic_research: 5 results, basic depth, images, "trending" prefix
    curl -s -X POST https://api.tavily.com/search \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg key "$TAVILY_API_KEY" --arg q "trending $query" \
            '{api_key:$key,query:$q,search_depth:"basic",max_results:5,include_images:true,include_raw_content:false}')" \
      | jq -c '{results: [.results[] | {title, url}], image_count: (.images | length)}'
  else
    # advanced_research: 10 results, advanced depth
    curl -s -X POST https://api.tavily.com/search \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg key "$TAVILY_API_KEY" --arg q "$query" \
            '{api_key:$key,query:$q,search_depth:"advanced",max_results:10}')" \
      | jq -c '{results: [.results[] | {title, url}], image_count: (.images | length)}'
  fi
}

# ── AcruxCore: render ────────────────────────────────────────────────────────
render_prompt() {
  curl -s -X POST "$ACRUXCORE_BASE_URL/prompts/web-research-agent/$ALIAS/render" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -d "{\"variables\":{\"question\":$(jq -Rn --arg q "$QUESTION" '$q')}}"
}

# ── Gateway: one completion, threading the trace via headers ─────────────────
complete() {
  local messages_json="$1" tools_json="$2" model="$3" trace_id="$4"
  local trace_header
  if [ -n "$trace_id" ]; then
    trace_header=(-H "x-trace-id: $trace_id")
  else
    trace_header=(-H "x-trace-name: web-research-agent")
  fi
  curl -s -D /tmp/gw_headers.$$ -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    "${trace_header[@]}" \
    -d "$(jq -n --arg model "$model" --argjson messages "$messages_json" --argjson tools "$tools_json" \
          '{model:$model,messages:$messages,tools:$tools}')"
}

report_tool_span() {
  local trace_id="$1" name="$2" started="$3" ended="$4" args_json="$5" result_json="$6"
  curl -s -X POST "$ACRUXCORE_BASE_URL/traces" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n \
        --arg traceId "$trace_id" --arg spanId "${name}-${started}" --arg name "$name" \
        --arg started "$started" --arg ended "$ended" --argjson args "$args_json" --argjson result "$result_json" \
        '{traces:[{traceId:$traceId,capturePayloads:true,spans:[{
          spanId:$spanId,name:$name,kind:"tool",status:"ok",startTime:$started,endTime:$ended,
          input:$args,output:$result}]}]}')" > /dev/null
}

# ── The agent loop ────────────────────────────────────────────────────────────
rendered=$(render_prompt)
messages=$(echo "$rendered" | jq -c '.messages')
tools=$(echo "$rendered" | jq -c '.tools')
model=$(echo "$rendered" | jq -r '.model')

echo "Alias: $ALIAS -> model $model"
echo "Question: $QUESTION"
echo

trace_id=""
for turn in 1 2 3 4; do
  headers_file=/tmp/gw_headers.$$
  response=$(complete "$messages" "$tools" "$model" "$trace_id")
  trace_id=$(grep -i '^x-gateway-trace-id:' "$headers_file" | tr -d '\r' | cut -d' ' -f2)
  rm -f "$headers_file"

  message=$(echo "$response" | jq -c '.choices[0].message')
  messages=$(echo "$messages" | jq -c --argjson m "$message" '. + [$m]')

  tool_calls=$(echo "$message" | jq -c '.tool_calls // empty')
  if [ -z "$tool_calls" ]; then
    echo "Assistant: $(echo "$message" | jq -r '.content')"
    echo
    echo "($turn model turn(s), trace $trace_id)"
    exit 0
  fi

  while IFS= read -r call; do
    [ -z "$call" ] && continue
    call_id=$(echo "$call" | jq -r '.id')
    name=$(echo "$call" | jq -r '.function.name')
    args_json=$(echo "$call" | jq -c '.function.arguments | fromjson')
    query=$(echo "$args_json" | jq -r '.query')

    started=$(now)
    result=$(web_research "$query")
    ended=$(now)

    echo "  -> ${name}($(echo "$args_json" | jq -c .))"
    echo "     $result" | head -c 300
    echo

    report_tool_span "$trace_id" "$name" "$started" "$ended" "$args_json" "$result"

    messages=$(echo "$messages" | jq -c --arg cid "$call_id" --argjson content "$result" \
      '. + [{role:"tool", tool_call_id:$cid, content:($content|tostring)}]')
  done < <(echo "$tool_calls" | jq -c '.[]')
done

echo "Stopped: hit the turn limit without a final answer."
