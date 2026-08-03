"""Leg 1 of 2: run the shared get_weather agent and trace it to LangSmith.

The tool lives in the script (LangSmith has no tool registry — a tool is a
decorated Python function), and `@traceable(run_type="tool")` is what turns the
call into its own span. `wrap_openai` patches the client so every completion is
an `llm` span with token counts.

Run:
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python examples/tool_agent_langsmith.py

Needs: pip install openai requests langsmith
"""

import json
import os
import sys

from langsmith import traceable
from langsmith.run_helpers import get_current_run_tree
from langsmith.wrappers import wrap_openai
from openai import OpenAI

from weather_tool_shared import (
    MODEL_OPENROUTER,
    WEATHER_TOOL_SCHEMA,
    build_messages,
    get_weather,
    tool_result_message,
)

PROJECT = "weather-tool-agent"

# Tracing is opt-in via env, so set it before the first traced call is made.
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = PROJECT
os.environ["LANGSMITH_PROJECT"] = PROJECT

if not os.environ.get("LANGSMITH_API_KEY"):
    sys.exit("LANGSMITH_API_KEY is not set")
if not os.environ.get("OPENROUTER_API_KEY"):
    sys.exit("OPENROUTER_API_KEY is not set")

# wrap_openai is the whole LLM instrumentation: same client API, every call now
# reports itself to LangSmith as an `llm` run.
client = wrap_openai(
    OpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
    )
)


@traceable(run_type="tool", name="get_weather")
def traced_get_weather(city: str) -> dict:
    """The shared tool, wrapped so LangSmith records it as a `tool` span.

    Nothing about the tool changes — the decorator is the only difference between
    this and calling `get_weather` directly.
    """
    return get_weather(city)


@traceable(run_type="chain", name="weather-tool-agent")
def run_agent() -> dict:
    """Drive the tool-calling loop until the model answers without a tool call.

    Returns the final answer plus the LangSmith root run id, so the caller can
    print a deep link to the trace.
    """
    messages = build_messages()
    tool_calls_made = []

    for _ in range(4):  # generous bound; this conversation needs 2 turns
        completion = client.chat.completions.create(
            model=MODEL_OPENROUTER,
            messages=messages,
            tools=[WEATHER_TOOL_SCHEMA],
        )
        choice = completion.choices[0].message
        messages.append(choice.model_dump(exclude_none=True))

        if not choice.tool_calls:
            run = get_current_run_tree()
            return {
                "answer": choice.content,
                "tool_calls": tool_calls_made,
                "root_run_id": str(run.id) if run else None,
                "trace_id": str(run.trace_id) if run else None,
            }

        for call in choice.tool_calls:
            args = json.loads(call.function.arguments)
            result = traced_get_weather(**args)
            tool_calls_made.append({"name": call.function.name, "args": args, "result": result})
            messages.append(tool_result_message(call.id, result))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(json.dumps(out, indent=2))
    if out["trace_id"]:
        print(f"\nLangSmith project: {PROJECT}")
        print(f"trace id: {out['trace_id']}")
