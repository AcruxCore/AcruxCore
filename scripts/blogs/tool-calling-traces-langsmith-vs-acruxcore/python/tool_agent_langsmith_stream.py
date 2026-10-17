"""Streaming variant of the LangSmith leg.

Same agent as `tool_agent_langsmith.py`, with `stream=True` on every completion.
A streamed tool call arrives in pieces, so the loop folds the deltas together with
the shared `ToolCallAccumulator` and rebuilds the assistant turn before running the
tool.

Run:
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/tool_agent_langsmith_stream.py

Needs: pip install openai requests langsmith
"""

import json
import os
import sys
from pathlib import Path

from langsmith import traceable
from langsmith.run_helpers import get_current_run_tree
from langsmith.wrappers import wrap_openai
from openai import OpenAI

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from weather_tool_shared import (  # noqa: E402
    MODEL_OPENROUTER,
    WEATHER_TOOL_SCHEMA,
    ToolCallAccumulator,
    assistant_tool_call_message,
    build_messages,
    get_weather,
    tool_result_message,
)

PROJECT = "weather-tool-agent"

os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = PROJECT
os.environ["LANGSMITH_PROJECT"] = PROJECT

if not os.environ.get("LANGSMITH_API_KEY"):
    sys.exit("LANGSMITH_API_KEY is not set")
if not os.environ.get("OPENROUTER_API_KEY"):
    sys.exit("OPENROUTER_API_KEY is not set")

client = wrap_openai(
    OpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
    )
)


@traceable(run_type="tool", name="get_weather")
def traced_get_weather(city: str) -> dict:
    """The shared tool, recorded by LangSmith as a `tool` span."""
    return get_weather(city)


@traceable(run_type="chain", name="weather-tool-agent-stream")
def run_agent() -> dict:
    """Drive the streamed tool-calling loop until the model answers without a tool call."""
    messages = build_messages()

    for _ in range(4):
        stream = client.chat.completions.create(
            model=MODEL_OPENROUTER,
            messages=messages,
            tools=[WEATHER_TOOL_SCHEMA],
            stream=True,
            # Without this, a streamed completion reports no token usage.
            stream_options={"include_usage": True},
        )
        acc = ToolCallAccumulator()
        text = ""
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                print(delta.content, end="", flush=True)
                text += delta.content
            acc.add(delta.tool_calls)

        calls = acc.finish()
        if not calls:
            run = get_current_run_tree()
            return {"answer": text, "trace_id": str(run.trace_id) if run else None}

        messages.append(assistant_tool_call_message(calls))
        for call in calls:
            print(f"[calling {call['name']}({call['arguments']})]")
            result = traced_get_weather(**call["arguments"])
            messages.append(tool_result_message(call["id"], result))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(f"\n\nLangSmith project: {PROJECT}")
    print(f"trace id: {out['trace_id']}")
