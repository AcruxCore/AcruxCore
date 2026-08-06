import asyncio

import httpx
from acruxcore import AcruxCore, acrux

MODEL = "support-model"


@acrux.tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: City name, e.g. 'London'.
    """
    async with httpx.AsyncClient() as http:
        res = await http.get(f"https://wttr.in/{city}", params={"format": "j1"})
    res.raise_for_status()
    current = res.json()["current_condition"][0]
    return {
        "city": city,
        "temp_c": int(current["temp_C"]),
        "summary": current["weatherDesc"][0]["value"],
    }


async def main() -> None:
    async with AcruxCore() as hub:
        print("1. Tool-calling loop (declares + syncs get_weather)")
        tool_result = await hub.gateway.run_tool_loop(
            model=MODEL,
            messages=[{"role": "user", "content": "What is the weather in London right now?"}],
            tools=[get_weather],
        )
        print("  ->", tool_result.content)
        print("  trace:", tool_result.trace_id)

        print("2. Non-streaming completion")
        chat_result = await hub.gateway.chat(MODEL, [{"role": "user", "content": "Say hi in one word."}])
        print("  ->", chat_result.content)

        print("3. Streaming completion")
        print("  -> ", end="", flush=True)
        async for chunk in await hub.gateway.stream(MODEL, [{"role": "user", "content": "Count to three."}]):
            print(chunk.delta.get("content", ""), end="", flush=True)
        print()

        print("4. Read the trace back and leave feedback")
        await hub.gateway.flush()
        trace = await hub.traces.get(tool_result.trace_id)
        print("  status:", trace.trace.status, "cost:", trace.trace.total_cost_usd)
        feedback = await hub.traces.submit_feedback(
            tool_result.trace_id, rating=1, label="weather-lookup-worked",
        )
        print("  feedback id:", feedback.id)


if __name__ == "__main__":
    asyncio.run(main())
