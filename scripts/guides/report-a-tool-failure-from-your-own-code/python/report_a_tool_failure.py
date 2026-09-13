"""
One weather tool, written two ways, against a real upstream that answers HTTP 200
when it has nothing to give you.

Open-Meteo's geocoder returns 200 and a body with no `results` key when it cannot
place a city. The request succeeded. The tool call did not. Nothing outside this
function can tell those apart, which is what ToolResult exists for.

Run it twice to see the difference:

  python report_a_tool_failure.py            # the tool declares its own failures
  python report_a_tool_failure.py --silent   # the same tool, staying quiet

Setup:
  pip install acruxcore
  export ACRUXCORE_API_KEY=<your api key>
  export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1
  export ACRUXCORE_MODEL=gpt-4o-mini-or
"""

import asyncio
import os
import sys

import httpx

from acruxcore import AcruxCore, ToolResult, acrux

MODEL = os.environ.get("ACRUXCORE_MODEL", "gpt-4o-mini-or")

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

#: Set by --silent. The tool body is otherwise identical, so the only variable
#: between the two runs is whether the tool reports what it knows.
SILENT = "--silent" in sys.argv


@acrux.tool
async def get_weather_brief(city: str) -> dict:
    """Get the current temperature for a city.

    Args:
        city: City name, for example 'Lahore'.
    """
    async with httpx.AsyncClient(timeout=10) as http:
        geo = (
            await http.get(GEOCODE_URL, params={"name": city, "count": 5})
        ).json()

        # The silent failure. HTTP 200, a well-formed body, and no city in it.
        matches = geo.get("results") or []
        if not matches:
            detail = f"Open-Meteo has no coordinates for {city!r}."
            if SILENT:
                return {"error": detail}
            return ToolResult.error("location_not_found", detail)

        place = matches[0]
        current = (
            await http.get(
                FORECAST_URL,
                params={
                    "latitude": place["latitude"],
                    "longitude": place["longitude"],
                    "current": "temperature_2m",
                },
            )
        ).json()["current"]

        reading = {
            "city": place["name"],
            "country": place.get("country"),
            "temp_c": current["temperature_2m"],
        }

        # Answered, but the name was ambiguous: Open-Meteo returns the most
        # populous match, so "Hyderabad" silently means the Indian one. Worth
        # seeing on the trace; not a failed run.
        countries = {m.get("country") for m in matches if m.get("country")}
        if len(countries) > 1:
            if SILENT:
                return reading
            return ToolResult.warn(
                "ambiguous_city",
                f"{city!r} matches places in {', '.join(sorted(countries))}. "
                f"Answered for {place['name']}, {place.get('country')}.",
                reading,
            )

        return reading


async def ask(hub: AcruxCore, question: str, tag: str) -> None:
    run = await hub.gateway.run_tool_loop(
        MODEL,
        [
            {
                "role": "system",
                "content": (
                    "You are a weather assistant. Always call the get_weather_brief tool, "
                    "even for a place you believe is fictional — the tool is the only "
                    "source of truth. If it cannot answer, say so plainly and never "
                    "invent a temperature."
                ),
            },
            {"role": "user", "content": question},
        ],
        tools=[get_weather_brief],
        trace={
            "name": "weather-brief",
            "tags": ["guide-tool-failure", "silent" if SILENT else "declared", tag],
        },
    )
    print(f"\nQ: {question}")
    print(f"A: {run.content}")
    print(f"   trace: {run.trace_id}")


async def main() -> None:
    mode = "SILENT (the tool keeps what it knows to itself)" if SILENT else "DECLARED"
    print(f"mode: {mode}\nmodel: {MODEL}")
    async with AcruxCore() as hub:
        await ask(hub, "What is the weather in Kathmandu?", "ok")
        await ask(hub, "What is the weather in Atlantis Prime?", "not-found")
        await ask(hub, "What is the weather in Hyderabad?", "ambiguous")


if __name__ == "__main__":
    asyncio.run(main())
