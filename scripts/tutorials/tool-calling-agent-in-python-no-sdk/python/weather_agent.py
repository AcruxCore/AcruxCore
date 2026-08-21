"""
Tool-calling agent in plain Python — no SDK, just `requests` against the Acrux
Core REST API. The tool runs on the CLIENT (in this process), not on the gateway.

Flow:
  1. render  — POST /prompts/:name/:alias/render -> {messages, tools}
  2. loop    — POST /gateway/chat/completions with the messages + tools.
               * first turn sends `x-trace-name` to open a trace; the gateway
                 replies with `x-gateway-trace-id`.
               * later turns send `x-trace-id` so every model turn lands in the
                 SAME trace.
               When the model asks for a tool, we run it here, POST a `tool`
               span to /traces (same trace id), append the result, and loop.
  3. done    — the model stops asking for tools; print its final answer.

Run:
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python weather_agent.py
"""

import json
import os
from datetime import datetime, timezone

import requests

API_KEY = os.environ["ACRUXCORE_API_KEY"]
BASE_URL = os.environ["ACRUXCORE_BASE_URL"].rstrip("/")
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def now() -> str:
    """Current time as an ISO-8601 string with a timezone offset (what /traces wants)."""
    return datetime.now(timezone.utc).isoformat()


# ── The tool, implemented on the client ──────────────────────────────────────
# Canned data keeps the example self-contained; a real tool would call a weather
# API, read a database, hit an internal service — anything your process can do.
WEATHER = {
    "tokyo": "22°C, light rain",
    "london": "15°C, overcast",
    "paris": "19°C, clear",
}


def get_weather(city: str) -> dict:
    """The local implementation the model's `get_weather` tool call routes to."""
    return {"city": city, "conditions": WEATHER.get(city.lower(), "no data for that city")}


def run_tool(name: str, args: dict):
    """Route one tool call from the model to its local implementation."""
    if name == "get_weather":
        return get_weather(**args)
    raise ValueError(f"Unknown tool: {name}")


# ── REST helpers ─────────────────────────────────────────────────────────────
def render_prompt(name: str, alias: str, variables: dict) -> dict:
    """Fetch the stored prompt: rendered messages + bound tool schemas."""
    r = requests.post(
        f"{BASE_URL}/prompts/{name}/{alias}/render",
        headers=HEADERS,
        json={"variables": variables},
    )
    r.raise_for_status()
    return r.json()


def complete(model, messages, tools, trace_id):
    """One gateway completion. Threads the trace; returns (message, trace_id)."""
    headers = dict(HEADERS)
    if trace_id:
        headers["x-trace-id"] = trace_id           # attach to the existing trace
    else:
        headers["x-trace-name"] = "py-weather-agent"  # open a new trace
    r = requests.post(
        f"{BASE_URL}/gateway/chat/completions",
        headers=headers,
        json={"model": model, "messages": messages, "tools": tools},
    )
    r.raise_for_status()
    # The gateway records the LLM span itself; we only need the trace id it used.
    trace_id = r.headers["x-gateway-trace-id"]
    return r.json()["choices"][0]["message"], trace_id


def log_tool_span(trace_id, name, args, result, started, ended):
    """Add a `tool` span for a client-side call to the SAME trace as the LLM spans."""
    requests.post(
        f"{BASE_URL}/traces",
        headers=HEADERS,
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


# ── The agent loop ───────────────────────────────────────────────────────────
def main():
    model = "gpt-4o-mini"
    rendered = render_prompt("py-weather-agent", "production", {"city": "Tokyo"})
    messages, tools = rendered["messages"], rendered["tools"]
    print(f"Fetched {len(messages)} message(s) + {len(tools)} tool(s) "
          f"[{', '.join(t['function']['name'] for t in tools)}]\n")

    trace_id = None
    for turn in range(1, 6):  # a small cap so a misbehaving model can't loop forever
        message, trace_id = complete(model, messages, tools, trace_id)
        messages.append(message)

        tool_calls = message.get("tool_calls")
        if not tool_calls:
            print("Assistant:", message["content"])
            print(f"\n({turn} model turn(s), trace {trace_id})")
            return

        for call in tool_calls:
            name = call["function"]["name"]
            args = json.loads(call["function"]["arguments"])
            started = now()
            result = run_tool(name, args)
            ended = now()
            print(f"  → {name}({args}) = {result}")
            log_tool_span(trace_id, name, args, result, started, ended)
            # Feed the tool result back so the model can use it next turn.
            messages.append({
                "role": "tool",
                "tool_call_id": call["id"],
                "content": json.dumps(result),
            })

    print("Stopped: hit the turn limit without a final answer.")


if __name__ == "__main__":
    main()
