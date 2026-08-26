"""
ReAct finance agent — BYO direct to the model provider, manual tool_calls loop, no gateway.

Flow:
  1. render  — POST /prompts/react-agent-finance/production/render (AcruxCore)
               -> {messages, tools, versionId}
  2. loop    — POST {PROVIDER_BASE_URL}/chat/completions DIRECTLY (never through
               AcruxCore's gateway). Any OpenAI-compatible provider works: point
               PROVIDER_BASE_URL at OpenAI, OpenRouter, Together, Groq or a local
               server, and set MODEL to an id that provider serves. Because no
               gateway sees this call, WE report the llm span ourselves: POST
               /traces after every turn, same shape run_tool_loop()/chat() would
               report on the BYO path (kind: llm, model, provider: the host really
               called, usage, promptVersionId).
               When the model asks for a tool, we run it locally (finance_research
               calls Yahoo's own news endpoint with `requests`; get_todays_date is
               a one-line local computation), append a `tool` span to the same
               trace, feed the result back, and loop.
  3. done    — the model stops asking for tools; print the final answer.

Run:
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  export PROVIDER_API_KEY=sk-...                              # your provider key
  export PROVIDER_BASE_URL=https://api.openai.com/v1          # or any OpenAI-compatible /v1
  export PROVIDER_MODEL=gpt-4o-mini                           # an id that provider serves
  python react_agent.py "Is there any recent news on AAPL, and is today a weekday?"

Only dependency: requests.
"""

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

import requests

ACRUXCORE_API_KEY = os.environ["ACRUXCORE_API_KEY"]
ACRUXCORE_BASE_URL = os.environ["ACRUXCORE_BASE_URL"].rstrip("/")
# BYO: called directly, never through AcruxCore. The base URL is the whole of the
# provider choice; PROVIDER_HOST is derived from it because that string goes on the span.
PROVIDER_API_KEY = os.environ["PROVIDER_API_KEY"]
PROVIDER_BASE_URL = os.environ.get("PROVIDER_BASE_URL", "https://api.openai.com/v1").rstrip("/")
PROVIDER_HOST = urlsplit(PROVIDER_BASE_URL).netloc
MODEL = os.environ.get("PROVIDER_MODEL", "gpt-4o-mini")
YAHOO_NEWS_URL = "https://finance.yahoo.com/xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin"

ACRUXCORE_HEADERS = {"Authorization": f"Bearer {ACRUXCORE_API_KEY}", "Content-Type": "application/json"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── The two tools, run locally (client executor — this process runs them) ────

async def finance_research(ticker_symbol: str, limit: int = 3) -> str:
    """Recent Yahoo Finance headlines for one ticker, as plain text for the model.

    Two HTTP calls, in this order and not the other: a GET to fc.yahoo.com whose
    only job is to leave a session cookie, then a POST to Yahoo's own news-stream
    API, which needs that cookie. Both need a browser-shaped User-Agent.

    This is what langchain_community's YahooFinanceNewsTool does internally. It is
    written out here instead because that package is being sunset upstream, and a
    tutorial should not install a dependency whose deprecation warning prints on
    the reader's first run (issue #352).
    """
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})
    session.get("https://fc.yahoo.com", timeout=15)  # 1. pick up the session cookie
    res = session.post(  # 2. the real news call
        YAHOO_NEWS_URL,
        json={"serviceConfig": {"snippetCount": limit, "s": [ticker_symbol]}},
        timeout=20,
    )
    res.raise_for_status()
    stream = res.json()["data"]["tickerStream"]["stream"]
    items = [
        f"{item['content']['title']}\n{item['content'].get('summary') or ''}".strip()
        for item in stream[:limit]
    ]
    return "\n\n".join(items) or f"No recent news found for {ticker_symbol}."


async def get_todays_date() -> str:
    """Get today's date."""
    return datetime.now().strftime("%Y-%m-%d")


async def run_tool(name: str, args: dict) -> str:
    if name == "finance_research":
        return await finance_research(**args)
    if name == "get_todays_date":
        return await get_todays_date()
    raise ValueError(f"Unknown tool: {name}")


# ── AcruxCore: render + manual trace reporting ──────────────────────────────

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
                            "provider": PROVIDER_HOST,
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
    """One completion sent straight to OpenAI — never through AcruxCore."""
    r = requests.post(
        f"{PROVIDER_BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {PROVIDER_API_KEY}", "Content-Type": "application/json"},
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
