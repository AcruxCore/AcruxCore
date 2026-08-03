"""Streaming variant of the LangSmith leg.

Same tool, same loop, `stream=True`. Two things change for the caller:
the assistant turn has to be rebuilt from `tool_calls` deltas, and usage only
arrives if `stream_options={"include_usage": True}` is asked for. Tracing itself
is unchanged — `wrap_openai` accumulates the stream into one `llm` run.

Run:
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python examples/tool_agent_langsmith_stream.py

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
    ToolCallAccumulator,
    assistant_tool_call_message,
    build_messages,
    get_weather,
    tool_result_message,
)

PROJECT = "weather-tool-agent-stream"

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
    """The shared tool, recorded as a `tool` span."""
    return get_weather(city)


@traceable(run_type="chain", name="weather-tool-agent-stream")
def run_agent() -> dict:
    """Tool-calling loop over a streamed completion."""
    messages = build_messages()
    tool_calls_made = []
    printed_chars = 0
    usage_reported = []

    for _ in range(4):
        stream = client.chat.completions.create(
            model=MODEL_OPENROUTER,
            messages=messages,
            tools=[WEATHER_TOOL_SCHEMA],
            stream=True,
            # Without this, a streamed response carries no token counts at all.
            stream_options={"include_usage": True},
        )

        acc = ToolCallAccumulator()
        text = ""
        for chunk in stream:
            if chunk.usage:
                usage_reported.append(chunk.usage.model_dump())
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
            run = get_current_run_tree()
            return {
                "answer": text,
                "tool_calls": tool_calls_made,
                "streamed_chars": printed_chars,
                "usage_frames": usage_reported,
                "trace_id": str(run.trace_id) if run else None,
            }

        messages.append(assistant_tool_call_message(calls))
        for call in calls:
            result = traced_get_weather(**call["arguments"])
            tool_calls_made.append(
                {"name": call["name"], "args": call["arguments"], "result": result}
            )
            messages.append(tool_result_message(call["id"], result))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(json.dumps(out, indent=2))
    print(f"\nLangSmith project: {PROJECT}")
