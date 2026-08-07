#!/usr/bin/env bash
# ReAct finance agent — BYO direct to OpenAI, manual tool_calls loop, no gateway,
# no SDK — plain curl and jq.
#
# Flow:
#   1. render  — POST /prompts/react-agent-finance/production/render (AcruxCore)
#                -> {messages, tools, versionId}
#   2. loop    — POST https://api.openai.com/v1/chat/completions DIRECTLY (never
#                through AcruxCore's gateway). Because no gateway sees this call,
#                WE report the llm span ourselves: POST /traces after every turn
#                (kind: llm, model, provider: the OpenAI host, usage, promptVersionId).
#                When the model asks for a tool, we run it locally, report a `tool`
#                span to the SAME trace, feed the result back, and loop.
#   3. done    — the model stops asking for tools; print the final answer.
#
# Run:
#   export ACRUXCORE_API_KEY=<your personal api key>
#   export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
#   export OPENAI_API_KEY=sk-...
#   ./react_agent.sh "Is there any recent news on AAPL, and is today a weekday?"
set -euo pipefail

QUESTION="${1:-Is there any recent news on AAPL, and is today a weekday?}"
OPENAI_BASE_URL="https://api.openai.com/v1"   # BYO: called directly, never through AcruxCore
MODEL="gpt-4o-mini"
TRACE_ID=$(python3 -c "import uuid; print(uuid.uuid4())")  # BYO: mint our own, no gateway trace to adopt

now() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }

# ── The two tools, run locally (client executor — this shell runs them) ──────

# The real endpoint YahooFinanceNewsTool itself calls under the hood (via
# yfinance's Ticker.news -> get_news(), see yfinance/base.py): a POST to
# finance.yahoo.com's internal news-stream API, after a plain GET to fc.yahoo.com
# to pick up a session cookie. No crumb needed for this endpoint (unlike Yahoo's
# /v1/finance/search), just the cookie.
finance_research() {
  local ticker="$1"
  local jar
  jar=$(mktemp)
  curl -s -c "$jar" -A "Mozilla/5.0" "https://fc.yahoo.com" -o /dev/null
  curl -s -b "$jar" -A "Mozilla/5.0" -X POST \
    "https://finance.yahoo.com/xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin" \
    -H "Content-Type: application/json" \
    -d "{\"serviceConfig\":{\"snippetCount\":3,\"s\":[\"${ticker}\"]}}" \
    | jq -r '.data.tickerStream.stream[] | "\(.content.title)\n\(.content.summary)"'
  rm -f "$jar"
}

get_todays_date() {
  date -u +%F
}

run_tool() {
  local name="$1" args_json="$2"
  case "$name" in
    finance_research)
      local ticker
      ticker=$(echo "$args_json" | jq -r '.ticker_symbol')
      finance_research "$ticker"
      ;;
    get_todays_date)
      get_todays_date
      ;;
    *)
      echo "Unknown tool: $name" >&2
      exit 1
      ;;
  esac
}

# ── AcruxCore: render + manual trace reporting ──────────────────────────────

render_prompt() {
  curl -s -X POST "$ACRUXCORE_BASE_URL/prompts/react-agent-finance/production/render" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -d "{\"variables\":{\"question\":$(jq -Rn --arg q "$QUESTION" '$q')}}"
}

report_llm_span() {
  local span_id="$1" model="$2" started="$3" ended="$4" usage_json="$5" version_id="$6" messages_json="$7" output_json="$8"
  curl -s -X POST "$ACRUXCORE_BASE_URL/traces" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n \
        --arg traceId "$TRACE_ID" --arg spanId "$span_id" --arg model "$model" \
        --arg started "$started" --arg ended "$ended" --arg versionId "$version_id" \
        --argjson usage "$usage_json" --argjson messages "$messages_json" --argjson output "$output_json" \
        '{traces:[{traceId:$traceId,name:"react-agent-finance",capturePayloads:true,spans:[{
          spanId:$spanId,name:$model,kind:"llm",status:"ok",startTime:$started,endTime:$ended,
          model:$model,provider:"api.openai.com",usage:$usage,promptVersionId:$versionId,
          input:{messages:$messages},output:$output}]}]}')" > /dev/null
}

report_tool_span() {
  local name="$1" started="$2" ended="$3" args_json="$4" result_text="$5"
  curl -s -X POST "$ACRUXCORE_BASE_URL/traces" \
    -H "Authorization: Bearer $ACRUXCORE_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n \
        --arg traceId "$TRACE_ID" --arg spanId "${name}-${started}" --arg name "$name" \
        --arg started "$started" --arg ended "$ended" --argjson args "$args_json" --arg result "$result_text" \
        '{traces:[{traceId:$traceId,capturePayloads:true,spans:[{
          spanId:$spanId,name:$name,kind:"tool",status:"ok",startTime:$started,endTime:$ended,
          input:$args,output:$result}]}]}')" > /dev/null
}

# ── OpenAI: called directly, BYO ──────────────────────────────────────────────

complete() {
  local messages_json="$1" tools_json="$2"
  curl -s -X POST "$OPENAI_BASE_URL/chat/completions" \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n --arg model "$MODEL" --argjson messages "$messages_json" --argjson tools "$tools_json" \
          '{model:$model,messages:$messages,tools:$tools}')"
}

# ── The agent loop ────────────────────────────────────────────────────────────

rendered=$(render_prompt)
messages=$(echo "$rendered" | jq -c '.messages')
tools=$(echo "$rendered" | jq -c '.tools')
version_id=$(echo "$rendered" | jq -r '.versionId')

echo "Question: $QUESTION"
echo "Fetched $(echo "$messages" | jq 'length') message(s) + $(echo "$tools" | jq 'length') tool(s)" \
  "[$(echo "$tools" | jq -r '[.[].function.name] | join(", ")')]"
echo

for turn in 1 2 3 4 5; do
  started=$(now)
  response=$(complete "$messages" "$tools")
  ended=$(now)

  model_used=$(echo "$response" | jq -r '.model')
  message=$(echo "$response" | jq -c '.choices[0].message')
  usage=$(echo "$response" | jq -c '{promptTokens: .usage.prompt_tokens, completionTokens: .usage.completion_tokens, totalTokens: .usage.total_tokens}')

  report_llm_span "llm-${turn}-$(python3 -c 'import uuid; print(uuid.uuid4())')" "$model_used" \
    "$started" "$ended" "$usage" "$version_id" "$messages" "$message"

  messages=$(echo "$messages" | jq -c --argjson m "$message" '. + [$m]')

  tool_calls=$(echo "$message" | jq -c '.tool_calls // empty')
  if [ -z "$tool_calls" ]; then
    echo "Assistant: $(echo "$message" | jq -r '.content')"
    echo
    echo "($turn model turn(s), trace $TRACE_ID)"
    exit 0
  fi

  while IFS= read -r call; do
    [ -z "$call" ] && continue
    call_id=$(echo "$call" | jq -r '.id')
    name=$(echo "$call" | jq -r '.function.name')
    args_json=$(echo "$call" | jq -c '.function.arguments | fromjson')

    t_started=$(now)
    result=$(run_tool "$name" "$args_json")
    t_ended=$(now)

    echo "  -> ${name}($(echo "$args_json" | jq -c .))"
    echo "     $(echo "$result" | head -1)"

    report_tool_span "$name" "$t_started" "$t_ended" "$args_json" "$result"

    result_json=$(jq -Rn --arg r "$result" '$r')
    messages=$(echo "$messages" | jq -c --arg cid "$call_id" --argjson content "$result_json" \
      '. + [{role:"tool", tool_call_id:$cid, content:$content}]')
  done < <(echo "$tool_calls" | jq -c '.[]')
done

echo "Stopped: hit the turn limit without a final answer."
