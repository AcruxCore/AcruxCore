"""Travel-planner agent: one platform-stored system prompt, three bound tools.

The system prompt and all three tool definitions live in Acrux Core. This script
supplies only the traveller's question and the code for the one tool whose
executor is `client`. The model decides which tools to call -- often one, sometimes
two, and for a general question, none at all.

Run it:

    pip install acruxcore
    export ACRUXCORE_API_KEY=acx_sk_...
    export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1   # or your own host
    python run_agent.py "Any flights from Amsterdam to Lisbon on 2026-08-28?"

With no argument it runs all four demo questions.
"""

import asyncio
import json
import pathlib
import sys
from datetime import date

from acruxcore import AcruxCore

DATA = pathlib.Path(__file__).resolve().parent.parent / "data" / "flights.json"

DEMO_QUESTIONS = [
    # Needs no tool at all -- general knowledge, so the loop ends on round 1.
    "What's the best time of year to visit Japan, and do I need a visa as a Dutch citizen?",
    # Needs exactly one tool: search_flights.
    "Any flights from Amsterdam to Lisbon on 2026-08-28?",
    # Needs exactly one tool: get_city_weather.
    "Should I pack a raincoat for Lisbon? I land tomorrow.",
    # Needs two tools in one turn: get_city_weather and convert_currency.
    "I'm in Lisbon for the next three days with a budget of 500 EUR. "
    "What's the weather, and what is that worth in Japanese yen?",
]


def search_flights(origin: str, destination: str, departure_date: str) -> dict:
    """Look up the in-house flight inventory. This is the `client` executor.

    Acrux Core stores this tool's name, description and JSON Schema so the model
    knows how to call it, but never the code or the data -- both stay here. The
    parameters are the schema's own field names: a `client_tools` function is called
    with them as keywords, so they have to match.
    """
    inventory = json.loads(DATA.read_text())["routes"]
    key = f"{origin.strip().lower()}|{destination.strip().lower()}"
    flights = inventory.get(key, [])
    return {
        "origin": origin,
        "destination": destination,
        "departure_date": departure_date,
        "flights": flights,
        "count": len(flights),
    }


async def ask(hub: AcruxCore, question: str) -> None:
    # 1. The system prompt lives on the platform. Render it -- this also returns
    #    the version's bound model and the tools bound to this prompt alias.
    rendered = await hub.prompts.render(
        "travel-planner",
        "production",
        {"today": date.today().isoformat()},
    )

    # 2. The traveller's question is appended here, client-side. A tool loop has to
    #    own its message list, so the user turn is added rather than sent as a
    #    `prompt` reference.
    messages = [*rendered.messages, {"role": "user", "content": question}]

    # 3. Run the loop. Tools bound to the prompt, the bound model and the prompt
    #    version id all come from `rendered`, so nothing is restated here.
    #    `client_tools` names the one tool this app has to run itself. The two http
    #    tools are absent because the platform runs those -- nothing to supply.
    result = await hub.gateway.run_prompt_with_tools(
        rendered,
        messages=messages,
        client_tools={"search_flights": search_flights},
    )

    called = [
        call["function"]["name"]
        for message in result.messages
        if message.get("role") == "assistant"
        for call in (message.get("tool_calls") or [])
    ]

    print(f"\n\033[1mQ:\033[0m {question}")
    print(f"\033[2mrounds: {result.iterations}  tools called: {called or 'none'}\033[0m")
    print(f"\033[1mA:\033[0m {result.content}")
    if result.trace_id:
        print(f"\033[2mtrace: {result.trace_id}\033[0m")


async def main() -> None:
    questions = sys.argv[1:] or DEMO_QUESTIONS
    async with AcruxCore() as hub:
        for question in questions:
            await ask(hub, question)


if __name__ == "__main__":
    asyncio.run(main())
