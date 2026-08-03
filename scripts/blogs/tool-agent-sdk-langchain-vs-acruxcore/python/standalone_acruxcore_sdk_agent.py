"""Complete, self-contained Acrux Core SDK tool agent.

Copy-pasteable: no local imports, nothing to set up first. `@acrux.tool` carries the
name, the model-facing description and the argument schema, and `run_tool_loop`
reconciles that with the Tool Catalog on its first call. This is the version embedded
in the blog post, kept here so it can be run and stay honest.

  pip install acruxcore requests
  export ACRUXCORE_API_KEY=acx_sk_...
  python standalone_acruxcore_sdk_agent.py

Registration is not a separate step any more. Nothing here is done out of band with
curl — which is what made an earlier version of this comparison undercount the work
on the Acrux Core side.
"""

import asyncio
import os

import requests
from acruxcore import AcruxCore, acrux

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
API_KEY = os.environ["ACRUXCORE_API_KEY"]
MODEL = "gpt-4o-mini"

SYSTEM_PROMPT = (
    "You are a concise outdoor-activity advisor. When a question depends on the "
    "weather, call the weather tool before answering. Answer in at most three "
    "sentences and always state the temperature you based the advice on."
)


@acrux.tool
def get_weather_standalone(city: str) -> dict:
    """Get the current weather for a city.

    Returns temperature in Celsius, what it feels like, a text condition, and humidity.

    Args:
        city: City name, e.g. 'Lahore'.
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


async def main() -> None:
    async with AcruxCore(api_key=API_KEY, base_url=BASE_URL) as client:
        result = await client.run_tool_loop(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": "Should I go for a run in Lahore this evening?"},
            ],
            # The first call creates the tool, commits v1 and points `production` at it.
            # A later run with an unchanged function commits nothing.
            tools=[get_weather_standalone],
            trace={"name": "weather-agent-standalone"},
        )

    print(result.content)
    print(f"\nTrace: {BASE_URL.replace('/api/v1', '')}/traces/{result.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
