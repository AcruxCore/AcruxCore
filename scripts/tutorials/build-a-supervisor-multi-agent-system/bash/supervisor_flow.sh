#!/usr/bin/env bash
# Supervisor multi-agent flow -- bash + curl + jq, gateway, manual tool_calls loop.
#
# Step A: render the router prompt, call the gateway with response_format set to a
#         typed { "route_to": ... } json_schema. No tools bound -- response_format
#         and tools are mutually exclusive on one request. Capture x-gateway-trace-id.
# Step B: render the matching subagent's own prompt + tools and loop by hand (curl has
#         no runToolLoop() equivalent), threading x-trace-id so both calls land in ONE trace.
set -euo pipefail

QUESTION="${1:-Research Tesla (TSLA) latest stock news and tell me if investors should be worried.}"

now() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }

finance_research() {
  local ticker="$1" jar
  jar=$(mktemp)
  curl -s -c "$jar" -A "Mozilla/5.0" "https://fc.yahoo.com" -o /dev/null
  curl -s -b "$jar" -A "Mozilla/5.0" -X POST \
    "https://finance.yahoo.com/xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin" \
    -H "Content-Type: application/json" \
    -d "{\"serviceConfig\":{\"snippetCount\":3,\"s\":[\"${ticker}\"]}}" \
    | jq -c '[.data.tickerStream.stream[] | {title: .content.title}]'
  rm -f "$jar"
}

advanced_research() {
  curl -s -X POST https://api.tavily.com/search -H "Content-Type: application/json" \
    -d "$(jq -n --arg key "$TAVILY_API_KEY" --arg q "$1" \
          '{api_key:$key,query:$q,search_depth:"advanced",max_results:10}')" \
    | jq -c '[.results[] | {title, url}]'
}

basic_research() {
  curl -s -X POST https://api.tavily.com/search -H "Content-Type: application/json" \
    -d "$(jq -n --arg key "$TAVILY_API_KEY" --arg q "trending $1" \
          '{api_key:$key,query:$q,search_depth:"basic",max_results:5,include_images:true,include_raw_content:false}')" \
    | jq -c '[.results[] | {title, url}]'
}

get_todays_date() { date -u +%F; }

run_tool() {
  case "$1" in
    finance_research) finance_research "$(echo "$2" | jq -r '.ticker_symbol')" ;;
    advanced_research) advanced_research "$(echo "$2" | jq -r '.query')" ;;
    basic_research) basic_research "$(echo "$2" | jq -r '.query')" ;;
    get_todays_date) get_todays_date ;;
    *) echo "Unknown tool: $1" >&2; exit 1 ;;
  esac
}

render_prompt() {
  curl -s -X POST "$ACRUXCORE_BASE_URL/prompts/$1/$2/render" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -d "{\"variables\":{\"$3\":$(jq -Rn --arg v "$4" '$v')}}"
}

report_tool_span() {
  curl -s -X POST "$ACRUXCORE_BASE_URL/traces" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n --arg traceId "$1" --arg spanId "${2}-${3}" --arg name "$2" \
        --arg started "$3" --arg ended "$4" --argjson args "$5" --arg result "$6" \
        '{traces:[{traceId:$traceId,capturePayloads:true,spans:[{
          spanId:$spanId,name:$name,kind:"tool",status:"ok",startTime:$started,endTime:$ended,
          input:$args,output:$result}]}]}')" > /dev/null
}

# -- Step A: router, response_format, no tools --
router_rendered=$(render_prompt "content-supervisor" "production" "question" "$QUESTION")
router_messages=$(echo "$router_rendered" | jq -c '.messages')
router_model=$(echo "$router_rendered" | jq -r '.model')
ROUTE_SCHEMA='{"type":"object","properties":{"route_to":{"type":"string","enum":["finance_research_agent","general_research_agent","writing_agent"]}},"required":["route_to"],"additionalProperties":false}'

route_headers=$(mktemp)
route_resp=$(curl -s -D "$route_headers" -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
  -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --arg model "$router_model" --argjson messages "$router_messages" --argjson schema "$ROUTE_SCHEMA" \
        '{model:$model,messages:$messages,response_format:{type:"json_schema",json_schema:{name:"route_decision",schema:$schema,strict:true}}}')")
route_to=$(echo "$route_resp" | jq -r '.choices[0].message.content | fromjson | .route_to')
trace_id=$(grep -i '^x-gateway-trace-id:' "$route_headers" | tr -d '\r' | cut -d' ' -f2)
rm -f "$route_headers"

echo "Question: $QUESTION"
echo "Step A -- routed to: $route_to  (trace $trace_id)"
echo

# -- Step B: the chosen subagent, hand-rolled tool loop, SAME trace --
case "$route_to" in
  finance_research_agent) subagent_name="finance-research-agent" ;;
  general_research_agent) subagent_name="general-research-agent" ;;
  writing_agent) subagent_name="writing-agent" ;;
esac

rendered=$(render_prompt "$subagent_name" "production" "task" "$QUESTION")
messages=$(echo "$rendered" | jq -c '.messages')
tools=$(echo "$rendered" | jq -c '.tools')
model=$(echo "$rendered" | jq -r '.model')

for turn in 1 2 3 4; do
  headers_file=$(mktemp)
  response=$(curl -s -D "$headers_file" -X POST "$ACRUXCORE_BASE_URL/gateway/chat/completions" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -H "x-trace-id: $trace_id" \
    -d "$(jq -n --arg model "$model" --argjson messages "$messages" --argjson tools "$tools" \
          '{model:$model,messages:$messages,tools:$tools}')")
  rm -f "$headers_file"

  message=$(echo "$response" | jq -c '.choices[0].message')
  messages=$(echo "$messages" | jq -c --argjson m "$message" '. + [$m]')
  tool_calls=$(echo "$message" | jq -c '.tool_calls // empty')
  if [ -z "$tool_calls" ]; then
    echo "Step B -- $route_to: $(echo "$message" | jq -r '.content')"
    echo
    echo "($turn model turn(s), trace $trace_id)"
    exit 0
  fi

  while IFS= read -r call; do
    [ -z "$call" ] && continue
    call_id=$(echo "$call" | jq -r '.id')
    name=$(echo "$call" | jq -r '.function.name')
    args_json=$(echo "$call" | jq -c '.function.arguments | fromjson')
    started=$(now); result=$(run_tool "$name" "$args_json"); ended=$(now)
    echo "  -> ${name}($(echo "$args_json" | jq -c .))"
    echo "     $(echo "$result" | head -c 200)"
    report_tool_span "$trace_id" "$name" "$started" "$ended" "$args_json" "$result"
    messages=$(echo "$messages" | jq -c --arg cid "$call_id" --arg content "$result" \
      '. + [{role:"tool", tool_call_id:$cid, content:$content}]')
  done < <(echo "$tool_calls" | jq -c '.[]')
done
echo "Stopped: hit the turn limit without a final answer."
