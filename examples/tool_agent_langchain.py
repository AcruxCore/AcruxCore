"""SDK leg: the same get_weather agent using LangChain + LangSmith.

The counterpart to `tool_agent_acruxcore_sdk.py`. LangChain's `create_agent`
owns the loop, `@tool` turns a plain function into a tool with a schema derived
from its type hints and docstring, and tracing needs no code at all — importing
LangChain with `LANGCHAIN_TRACING_V2=true` set is enough.

Run:
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python examples/tool_agent_langchain.py

Needs: pip install langchain langchain-openai langsmith
"""

import json
import os
import sys

PROJECT = "weather-tool-agent-langchain"

# Must be set before LangChain is imported — the tracer reads them at import time.
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = PROJECT
os.environ["LANGSMITH_PROJECT"] = PROJECT

if not os.environ.get("LANGSMITH_API_KEY"):
    sys.exit("LANGSMITH_API_KEY is not set")
if not os.environ.get("OPENROUTER_API_KEY"):
    sys.exit("OPENROUTER_API_KEY is not set")

from langchain.agents import create_agent  # noqa: E402  (after the env vars above)
from langchain_core.tools import tool  # noqa: E402
from langchain_openai import ChatOpenAI  # noqa: E402

from weather_tool_shared import (  # noqa: E402
    MODEL_OPENROUTER,
    QUESTION,
    SYSTEM_PROMPT,
    get_weather,
)


@tool
def get_weather_tool(city: str) -> dict:
    """Get the current weather for a city.

    Returns temperature in Celsius, what it feels like, a text condition, and humidity.

    Args:
        city: City name, e.g. 'Lahore' or 'Berlin'.
    """
    return get_weather(city)


def main() -> None:
    """Build the agent and run the same question through it."""
    model = ChatOpenAI(
        model=MODEL_OPENROUTER,
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
    )
    agent = create_agent(model=model, tools=[get_weather_tool], system_prompt=SYSTEM_PROMPT)

    result = agent.invoke({"messages": [{"role": "user", "content": QUESTION}]})

    messages = result["messages"]
    tool_calls = [
        {"name": tc["name"], "args": tc["args"]}
        for m in messages
        for tc in (getattr(m, "tool_calls", None) or [])
    ]
    print(
        json.dumps(
            {
                "answer": messages[-1].content,
                "tool_calls": tool_calls,
                "message_count": len(messages),
            },
            indent=2,
        )
    )
    print(f"\nLangSmith project: {PROJECT}")


if __name__ == "__main__":
    main()
