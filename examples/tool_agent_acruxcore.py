"""Leg 2 of 2: run the same get_weather agent through Acrux Core.

Two things move off the client compared to the LangSmith leg:

1. The tool is not a local function. It lives in the Tool Catalog as a versioned
   `http` executor, so this script fetches its JSON Schema from the catalog
   instead of declaring one, and calls `POST /tools/:id/execute` to run it.
2. Nothing here creates a span. The gateway writes the `llm` spans and the tool
   executor writes the `tool` span; the client only threads one `x-trace-id`
   through both so they land in the same trace.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...        # catalog reads + tool execute
  export ACRUXCORE_GATEWAY_KEY=agh_sk_...    # gateway completions
  python examples/tool_agent_acruxcore.py

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
    build_messages,
    tool_result_message,
)

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
TRACE_NAME = "weather-tool-agent"

API_KEY = os.environ.get("ACRUXCORE_API_KEY")
GATEWAY_KEY = os.environ.get("ACRUXCORE_GATEWAY_KEY")
if not API_KEY:
    sys.exit("ACRUXCORE_API_KEY is not set")
if not GATEWAY_KEY:
    sys.exit("ACRUXCORE_GATEWAY_KEY is not set")

# One trace id, minted here, carried by every call below. This is the whole
# correlation mechanism — there is no tracing SDK in this script.
TRACE_ID = str(uuid.uuid4())

client = OpenAI(api_key=GATEWAY_KEY, base_url=f"{BASE_URL}/gateway")
session = requests.Session()
session.headers["Authorization"] = f"Bearer {API_KEY}"


def register_tool() -> dict[str, Any]:
    """Define the tool here and reconcile the catalog with it, in one request.

    This is the Acrux Core equivalent of writing `get_weather` in the LangSmith
    example: the whole tool — arguments, target URL, response trimming — is
    declared in `weather_tool_shared` and committed from code, so this script
    needs no prior setup.

    `POST /tools/sync` is create-or-commit-or-nothing: it creates the tool if the
    name is new, commits a version only when the submitted spec differs from the
    live one, and moves the alias when it commits. So re-running this script with an
    unchanged spec makes one request and changes nothing.

    An `http` executor cannot come from `@acrux.tool` — a decorator describes a
    Python function, not a declarative request/response mapping — so this leg still
    posts the spec itself. That is the one registration case the decorator does not
    replace.
    """
    fn = WEATHER_TOOL_SCHEMA["function"]
    res = session.post(
        f"{BASE_URL}/tools/sync",
        json={
            "name": fn["name"],
            "description": fn["description"],
            "parametersSchema": fn["parameters"],
            # `http`: the platform performs the request and the trimming itself.
            "executor": WEATHER_HTTP_EXECUTOR,
            "source": "api",
        },
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


def execute_tool(tool_id: str, arguments: dict[str, Any], parent_span_id: str | None) -> dict[str, Any]:
    """Run the catalog tool server-side, inside the current trace.

    `traceContext` is the only tracing code in this file: it tells the platform
    which trace (and which parent span) to file the `tool` span under. The span
    itself — timing, arguments, result, tool version — is written by the platform.
    """
    body: dict[str, Any] = {
        "arguments": arguments,
        "traceContext": {"traceId": TRACE_ID},
    }
    if parent_span_id:
        body["traceContext"]["parentSpanId"] = parent_span_id

    res = session.post(f"{BASE_URL}/tools/{tool_id}/execute", json=body, timeout=40)
    res.raise_for_status()
    return res.json()


def gateway_headers() -> dict[str, str]:
    """Trace context for a gateway completion.

    `x-trace-name` is free text, so it is percent-encoded — HTTP header values
    must be ISO-8859-1 and the API decodes it back on arrival.
    """
    return {
        "x-trace-id": TRACE_ID,
        "x-trace-name": quote(TRACE_NAME),
        "x-capture-payloads": "true",
    }


def resolve_tool(name: str) -> dict[str, Any]:
    """Read the live schema back out of the catalog, by name.

    The point of the catalog is that it — not this file — is the source of truth for
    what the model is told. `POST /tools/resolve` returns the version the alias
    currently points at, as an OpenAI-shaped function definition, plus whether the
    platform can run it (`executorType: "http"` here).
    """
    res = session.post(f"{BASE_URL}/tools/resolve", json={"refs": [{"name": name}]}, timeout=20)
    res.raise_for_status()
    return res.json()["data"][0]


def run_agent() -> dict[str, Any]:
    """Same loop as the LangSmith leg, against a catalog-registered tool."""
    catalog = register_tool()
    resolved = resolve_tool(WEATHER_TOOL_SCHEMA["function"]["name"])
    tool_schema = {"type": "function", "function": resolved["function"]}
    messages = build_messages()
    tool_calls_made = []

    for _ in range(4):
        # with_raw_response is used only to read x-gateway-span-id back, so the
        # tool span can be parented under the llm turn that requested it.
        raw = client.chat.completions.with_raw_response.create(
            model=MODEL_ACRUXCORE,
            messages=messages,
            tools=[tool_schema],
            extra_headers=gateway_headers(),
        )
        llm_span_id = raw.headers.get("x-gateway-span-id")
        choice = raw.parse().choices[0].message
        messages.append(choice.model_dump(exclude_none=True))

        if not choice.tool_calls:
            return {
                "answer": choice.content,
                "tool_calls": tool_calls_made,
                "trace_id": TRACE_ID,
                "tool_version_used": catalog["versionNumber"],
                "tool_version_committed_now": catalog["committed"],
                "executor_type": resolved["executorType"],
            }

        for call in choice.tool_calls:
            args = json.loads(call.function.arguments)
            executed = execute_tool(catalog["toolId"], args, llm_span_id)
            tool_calls_made.append(
                {
                    "name": call.function.name,
                    "args": args,
                    "result": executed["result"],
                    "server_latency_ms": executed["latencyMs"],
                    "tool_version_id": executed["toolVersionId"],
                }
            )
            messages.append(tool_result_message(call.id, executed["result"]))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(json.dumps(out, indent=2))
    print(f"\nAcrux Core trace: {BASE_URL.replace('/api/v1', '')}/traces/{out['trace_id']}")
