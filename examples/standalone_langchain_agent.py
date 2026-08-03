"""Complete, self-contained LangChain + LangSmith tool agent.

Copy-pasteable: no local imports, nothing to set up first. This is the version
embedded in the blog post, kept here so it can be run and stay honest.

  pip install langchain langchain-openai langsmith requests
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python standalone_langchain_agent.py
"""

import os

# Must be set before LangChain is imported — the tracer reads them at import time.
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = "weather-agent-standalone"

import requests
from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

MODEL = "openai/gpt-4o-mini"
SYSTEM_PROMPT = (
    "You are a concise outdoor-activity advisor. When a question depends on the "
    "weather, call the weather tool before answering. Answer in at most three "
    "sentences and always state the temperature you based the advice on."
)


@tool
def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Returns temperature in Celsius, what it feels like, a text condition, and humidity.

    Args:
        city: City name, e.g. 'Lahore' or 'Berlin'.
    """
    res = requests.get(f"https://wttr.in/{city}", params={"format": "j1"}, timeout=20)
    res.raise_for_status()
    payload = res.json()
    current = payload["current_condition"][0]
    return {
        "location": payload["nearest_area"][0]["areaName"][0]["value"],
        "temp_c": int(current["temp_C"]),
        "feels_like_c": int(current["FeelsLikeC"]),
        "condition": current["weatherDesc"][0]["value"],
        "humidity_pct": int(current["humidity"]),
    }


def main() -> None:
    model = ChatOpenAI(
        model=MODEL,
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
    )
    agent = create_agent(model=model, tools=[get_weather], system_prompt=SYSTEM_PROMPT)

    result = agent.invoke(
        {"messages": [{"role": "user", "content": "Should I go for a run in Lahore this evening?"}]}
    )

    print(result["messages"][-1].content)
    print(f"\nTrace: smith.langchain.com → project '{os.environ['LANGCHAIN_PROJECT']}'")


if __name__ == "__main__":
    main()
