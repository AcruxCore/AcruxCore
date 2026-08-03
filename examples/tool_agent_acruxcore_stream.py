"""Streaming variant of the Acrux Core leg.

Same tool, same loop, `stream=True`. The gateway still writes the `llm` span and
the tool executor still writes the `tool` span, so the client gains no tracing
code — but it loses one thing: the streaming response does not send back
`x-gateway-span-id`, so the tool span cannot be parented under the llm turn that
asked for it. It is filed as a sibling in the same trace instead.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  export ACRUXCORE_GATEWAY_KEY=agh_sk_...
  python examples/tool_agent_acruxcore_stream.py

Needs: pip install openai requests
"""

import json
import os
import sys
import uuid
from typing import Any
from urllib.parse import quote

import requests
from openai import OpenAI

from weather_tool_shared import (
    MODEL_ACRUXCORE,
    WEATHER_HTTP_EXECUTOR,
    WEATHER_TOOL_SCHEMA,
    ToolCallAccumulator,
    assistant_tool_call_message,
    build_messages,
    tool_result_message,
)

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
TRACE_NAME = "weather-tool-agent-stream"

API_KEY = os.environ.get("ACRUXCORE_API_KEY")
GATEWAY_KEY = os.environ.get("ACRUXCORE_GATEWAY_KEY")
if not API_KEY:
    sys.exit("ACRUXCORE_API_KEY is not set")
if not GATEWAY_KEY:
    sys.exit("ACRUXCORE_GATEWAY_KEY is not set")

TRACE_ID = str(uuid.uuid4())

client = OpenAI(api_key=GATEWAY_KEY, base_url=f"{BASE_URL}/gateway")
session = requests.Session()
session.headers["Authorization"] = f"Bearer {API_KEY}"


def register_tool() -> dict[str, Any]:
    """Reconcile the catalog with the tool defined in code, in one request.

    `POST /tools/sync` is create-or-commit-or-nothing — see the non-streaming leg for
    the full note. An `http` executor cannot come from `@acrux.tool`, so this leg
    posts the spec itself.
    """
    fn = WEATHER_TOOL_SCHEMA["function"]
    res = session.post(
        f"{BASE_URL}/tools/sync",
        json={
            "name": fn["name"],
            "description": fn["description"],
            "parametersSchema": fn["parameters"],
            "executor": WEATHER_HTTP_EXECUTOR,
            "source": "api",
        },
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


def resolve_tool(name: str) -> dict[str, Any]:
    """Read the live schema back out of the catalog, by name (see the non-streaming leg)."""
    res = session.post(f"{BASE_URL}/tools/resolve", json={"refs": [{"name": name}]}, timeout=20)
    res.raise_for_status()
    return res.json()["data"][0]


def execute_tool(tool_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Run the catalog tool inside the current trace.

    No `parentSpanId` here: the streamed completion never told us the llm span's
    id, so the platform files this span at the top level of the trace.
    """
    res = session.post(
        f"{BASE_URL}/tools/{tool_id}/execute",
        json={"arguments": arguments, "traceContext": {"traceId": TRACE_ID}},
        timeout=40,
    )
    res.raise_for_status()
    return res.json()


def run_agent() -> dict[str, Any]:
    """Tool-calling loop over a streamed gateway completion."""
    catalog = register_tool()
    resolved = resolve_tool(WEATHER_TOOL_SCHEMA["function"]["name"])
    tool_schema = {"type": "function", "function": resolved["function"]}
    messages = build_messages()
    tool_calls_made = []
    printed_chars = 0

    for _ in range(4):
        stream = client.chat.completions.create(
            model=MODEL_ACRUXCORE,
            messages=messages,
            tools=[tool_schema],
            stream=True,
            extra_headers={
                "x-trace-id": TRACE_ID,
                "x-trace-name": quote(TRACE_NAME),
                "x-capture-payloads": "true",
            },
        )

        acc = ToolCallAccumulator()
        text = ""
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                text += delta.content
                print(delta.content, end="", flush=True)
                printed_chars += len(delta.content)
            acc.add(delta.tool_calls)

        calls = acc.finish()

        if not calls:
            print()
            return {
                "answer": text,
                "tool_calls": tool_calls_made,
                "streamed_chars": printed_chars,
                "trace_id": TRACE_ID,
                "tool_version_used": catalog["versionNumber"],
            }

        messages.append(assistant_tool_call_message(calls))
        for call in calls:
            executed = execute_tool(catalog["toolId"], call["arguments"])
            tool_calls_made.append(
                {
                    "name": call["name"],
                    "args": call["arguments"],
                    "result": executed["result"],
                    "server_latency_ms": executed["latencyMs"],
                }
            )
            messages.append(tool_result_message(call["id"], executed["result"]))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(json.dumps(out, indent=2))
    print(f"\nAcrux Core trace: {BASE_URL.replace('/api/v1', '')}/traces/{out['trace_id']}")
