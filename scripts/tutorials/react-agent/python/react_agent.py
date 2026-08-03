"""
ReAct finance agent — BYO direct to OpenAI, manual tool_calls loop, no gateway.

Flow:
  1. render  — POST /prompts/react-agent-finance/production/render (Acrux Core)
               -> {messages, tools, versionId}
  2. loop    — POST https://api.openai.com/v1/chat/completions DIRECTLY (never
               through Acrux Core's gateway). Because no gateway sees this call,
               WE report the llm span ourselves: POST /traces after every turn,
               same shape run_tool_loop()/chat() would report on the BYO path
               (kind: llm, model, provider: the OpenAI host, usage, promptVersionId).
               When the model asks for a tool, we run it locally (finance_research
               calls the real langchain_community YahooFinanceNewsTool;
               get_todays_date is a one-line local computation), append a `tool`
               span to the same trace, feed the result back, and loop.
  3. done    — the model stops asking for tools; print the final answer.

Run:
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  export OPENAI_API_KEY=sk-...
  python react_agent.py "Is there any recent news on AAPL, and is today a weekday?"
"""

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone

import requests
from langchain_community.tools.yahoo_finance_news import YahooFinanceNewsTool

ACRUXCORE_API_KEY = os.environ["ACRUXCORE_API_KEY"]
ACRUXCORE_BASE_URL = os.environ["ACRUXCORE_BASE_URL"].rstrip("/")
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
OPENAI_BASE_URL = "https://api.openai.com/v1"  # BYO: called directly, never through Acrux Core
MODEL = "gpt-4o-mini"

ACRUXCORE_HEADERS = {"Authorization": f"Bearer {ACRUXCORE_API_KEY}", "Content-Type": "application/json"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── The two tools, run locally (client executor — this process runs them) ────

async def finance_research(ticker_symbol: str) -> str:
    """Search Yahoo Finance news for a ticker symbol. Verbatim from the source
    agent: langchain-samples/assistants-demo, agents/react_agent/tools.py."""
    wrapped = YahooFinanceNewsTool()
    return await wrapped.ainvoke({"query": ticker_symbol})


async def get_todays_date() -> str:
    """Get today's date."""
    return datetime.now().strftime("%Y-%m-%d")


async def run_tool(name: str, args: dict) -> str:
    if name == "finance_research":
        return await finance_research(**args)
    if name == "get_todays_date":
        return await get_todays_date()
    raise ValueError(f"Unknown tool: {name}")


# ── Acrux Core: render + manual trace reporting ──────────────────────────────

def render_prompt(name: str, alias: str, variables: dict) -> dict:
    r = requests.post(
        f"{ACRUXCORE_BASE_URL}/prompts/{name}/{alias}/render",
        headers=ACRUXCORE_HEADERS,
        json={"variables": variables},
    )
    r.raise_for_status()
    return r.json()


def report_llm_span(trace_id, span_id, model, started, ended, usage, prompt_version_id, messages, output_message):
    """Report one `llm` span ourselves — on the BYO path there is no gateway to do
    it for us. Mirrors what the SDK's chat() reports for a direct-to-provider call."""
    requests.post(
        f"{ACRUXCORE_BASE_URL}/traces",
        headers=ACRUXCORE_HEADERS,
        json={
            "traces": [
                {
                    "traceId": trace_id,
                    "name": "react-agent-finance",
                    "capturePayloads": True,
                    "spans": [
                        {
                            "spanId": span_id,
                            "name": model,
                            "kind": "llm",
                            "status": "ok",
                            "startTime": started,
                            "endTime": ended,
                            "model": model,
                            "provider": "api.openai.com",
                            "usage": usage,
                            "promptVersionId": prompt_version_id,
                            "input": {"messages": messages},
                            "output": output_message,
                        }
                    ],
                }
            ]
        },
    ).raise_for_status()


def report_tool_span(trace_id, name, args, result, started, ended):
    requests.post(
        f"{ACRUXCORE_BASE_URL}/traces",
        headers=ACRUXCORE_HEADERS,
        json={
            "traces": [
                {
                    "traceId": trace_id,
                    "capturePayloads": True,
                    "spans": [
                        {
                            "spanId": f"{name}-{started}",
                            "name": name,
                            "kind": "tool",
                            "status": "ok",
                            "startTime": started,
                            "endTime": ended,
                            "input": args,
                            "output": result,
                        }
                    ],
                }
            ]
        },
    ).raise_for_status()


# ── OpenAI: called directly, BYO ──────────────────────────────────────────────

def complete(model: str, messages: list, tools: list) -> dict:
    """One completion sent straight to OpenAI — never through Acrux Core."""
    r = requests.post(
        f"{OPENAI_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={"model": model, "messages": messages, "tools": tools},
    )
    r.raise_for_status()
    return r.json()


# ── The agent loop ────────────────────────────────────────────────────────────

async def main():
    question = sys.argv[1] if len(sys.argv) > 1 else "Is there any recent news on AAPL, and is today a weekday?"
    rendered = render_prompt("react-agent-finance", "production", {"question": question})
    messages, tools = rendered["messages"], rendered["tools"]
    version_id = rendered["versionId"]
    print(f"Question: {question}")
    print(f"Fetched {len(messages)} message(s) + {len(tools)} tool(s) "
          f"[{', '.join(t['function']['name'] for t in tools)}]\n")

    trace_id = str(uuid.uuid4())  # BYO: no gateway trace to adopt, mint our own
    for turn in range(1, 6):
        started = now()
        data = complete(MODEL, messages, tools)
        ended = now()
        choice = data["choices"][0]
        message = choice["message"]
        usage = data.get("usage") or {}
        report_llm_span(
            trace_id, f"llm-{turn}-{uuid.uuid4()}", data["model"], started, ended,
            {
                "promptTokens": usage.get("prompt_tokens"),
                "completionTokens": usage.get("completion_tokens"),
                "totalTokens": usage.get("total_tokens"),
            },
            version_id, messages, message,
        )
        messages.append(message)

        tool_calls = message.get("tool_calls")
        if not tool_calls:
            print("Assistant:", message["content"])
            print(f"\n({turn} model turn(s), trace {trace_id})")
            return

        for call in tool_calls:
            name = call["function"]["name"]
            args = json.loads(call["function"]["arguments"])
            t_started = now()
            result = await run_tool(name, args)
            t_ended = now()
            print(f"  -> {name}({args})")
            print(f"     {result[:200] if isinstance(result, str) else result}")
            report_tool_span(trace_id, name, args, result, t_started, t_ended)
            messages.append({
                "role": "tool",
                "tool_call_id": call["id"],
                "content": json.dumps(result),
            })

    print("Stopped: hit the turn limit without a final answer.")


if __name__ == "__main__":
    asyncio.run(main())
