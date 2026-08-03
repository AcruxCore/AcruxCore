"""A tool whose body is a Python function: the `client` executor pattern.

The other Acrux Core examples use an `http` executor, where the platform makes the
request itself. That only works for "call this URL and reshape the JSON". As soon
as a tool has real logic you want it in your own language, with your own tests —
and that is what `{"type": "client"}` is for:

    the catalog owns the CONTRACT   — name, description, parametersSchema,
                                      version number, production/staging aliases
    your code owns the BODY         — this file's `best_run_hour`

The platform deliberately refuses to execute such a version:

    POST /tools/:id/execute  ->  422 {"code":"NOT_EXECUTABLE"}

...because there is nothing server-side to call. `@acrux.tool` is the other half of
the contract: it derives the schema the catalog holds, and the decorated function is
the body the loop calls. The SDK still records the `tool` span.

Run (no prior setup — the tool is defined in code and synced on first run):
  export ACRUXCORE_API_KEY=acx_sk_...
  python examples/tool_agent_acruxcore_client_executor.py

Needs: pip install acruxcore requests
"""

import asyncio
import json
import os
import sys
from typing import Any

import requests
from acruxcore import AcruxCore, acrux

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
TRACE_NAME = "best-run-hour-agent"
MODEL = "gpt-4o-mini"

# The evening window we are willing to run in, as local hours.
WINDOW_START_HOUR = 17
WINDOW_END_HOUR = 21

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


@acrux.tool
def best_run_hour(city: str) -> dict[str, Any]:
    """Given a city, pick the best hour this evening for a run based on the hourly forecast, and say why.

    This is the kind of tool that cannot be an `http` executor: it fetches a
    forecast, filters to a time window, scores each hour on a heat-plus-humidity
    penalty, and picks a winner. Declarative request/response mapping cannot
    express that, and the platform's response transforms are sandboxed to pure
    data-shaping (no network, 1s budget) — so the body belongs here.

    The first paragraph above is what the model reads: `@acrux.tool` sends it as the
    version's description, and everything after the blank line stays in the source.

    Args:
        city: City name, e.g. 'Lahore'.
    """
    res = requests.get(f"https://wttr.in/{city}", params={"format": "j1"}, timeout=20)
    res.raise_for_status()
    payload = res.json()

    candidates = []
    for hour in payload["weather"][0]["hourly"]:
        # wttr.in reports `time` as "0", "300", "600" … i.e. HHMM without padding.
        hour_of_day = int(hour["time"]) // 100
        if not WINDOW_START_HOUR <= hour_of_day <= WINDOW_END_HOUR:
            continue
        temp_c = int(hour["tempC"])
        humidity = int(hour["humidity"])
        # Humidity matters less than heat but still costs comfort; the 0.1 weight
        # keeps a humid-but-cool hour ahead of a dry-but-scorching one.
        candidates.append(
            {
                "hour": f"{hour_of_day:02d}:00",
                "temp_c": temp_c,
                "humidity_pct": humidity,
                "discomfort": round(temp_c + 0.1 * humidity, 1),
            }
        )

    if not candidates:
        return {"city": city, "error": "no hourly forecast in the evening window"}

    best = min(candidates, key=lambda c: c["discomfort"])
    return {
        "city": city,
        "window": f"{WINDOW_START_HOUR:02d}:00-{WINDOW_END_HOUR:02d}:00",
        "best_hour": best["hour"],
        "temp_c": best["temp_c"],
        "humidity_pct": best["humidity_pct"],
        "considered": candidates,
    }


def assert_not_server_executable(tool_id: str, api_key: str) -> int:
    """Confirm the platform refuses to run this version, and return the status.

    Included because it is the whole point of a `client` executor: the catalog
    describes the tool, but execution is the caller's job.
    """
    res = requests.post(
        f"{BASE_URL}/tools/{tool_id}/execute",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"arguments": {"city": "Lahore"}},
        timeout=30,
    )
    return res.status_code


async def main() -> None:
    api_key = os.environ["ACRUXCORE_API_KEY"]

    async with AcruxCore(api_key=api_key, base_url=BASE_URL) as client:
        # `run_tool_loop` would sync this itself; syncing here first is only so the
        # tool id is in hand for the 422 check below. The loop's own sync is cached
        # per process, so this costs one request, not two.
        synced = await client.tools.sync([best_run_hour])
        tool_id = synced[0].tool_id

        status = assert_not_server_executable(tool_id, api_key)
        print(f"POST /tools/{tool_id[:8]}…/execute -> {status} (422 = client executor)\n")

        result = await client.run_tool_loop(
            model=MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You advise on outdoor exercise. Call best_run_hour before "
                    "answering, and name the hour and temperature you chose.",
                },
                {"role": "user", "content": "When should I run in Lahore this evening?"},
            ],
            # Schema derived from the function; body IS the function.
            tools=[best_run_hour],
            trace={"name": TRACE_NAME},
        )

    print(json.dumps({"answer": result.content, "iterations": result.iterations}, indent=2))
    print(f"\nAcrux Core trace: {BASE_URL.replace('/api/v1', '')}/traces/{result.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
