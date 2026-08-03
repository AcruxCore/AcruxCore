"""Chain 5 gateway calls into one trace, nested as a waterfall, with a named
trace + tags + metadata (LangSmith-style).

PREVIEW — this is the target API shape we're aligning on before implementing
it. Today the gateway only understands x-trace-id / x-parent-span-id /
x-session-id / x-capture-payloads. This script also uses x-span-id,
x-trace-name, x-trace-tags, and x-trace-metadata, which do not exist in the
API yet.

Needs: pip install openai requests
"""

import json
import os
import uuid

import requests
from openai import OpenAI

BASE_URL = "http://localhost:3001/api/v1"
GATEWAY_KEY = os.environ.get("ACRUXCORE_GATEWAY_KEY", "agh_sk_REPLACE_WITH_YOUR_GATEWAY_KEY")

client = OpenAI(api_key=GATEWAY_KEY, base_url=f"{BASE_URL}/gateway")

# Every id is minted by US, up front — nothing is read back from a response.
trace_id = str(uuid.uuid4())
span_detect_intent = str(uuid.uuid4())
span_extract_dates = str(uuid.uuid4())
span_flights = str(uuid.uuid4())
span_hotels = str(uuid.uuid4())
span_compose = str(uuid.uuid4())


def call(span_id: str, parent_span_id: str | None, model: str, content: str, mint_trace: bool = False):
    """One gateway completion, wired into the shared trace via headers."""
    headers = {
        "x-trace-id": trace_id,
        "x-span-id": span_id,
    }
    if parent_span_id:
        headers["x-parent-span-id"] = parent_span_id
    if mint_trace:
        # Only honored by the call that actually creates the trace row.
        headers["x-trace-name"] = "trip-planner-run"
        headers["x-trace-tags"] = "prod,travel-bot"
        headers["x-trace-metadata"] = json.dumps({"userId": "u_789", "tripId": "trip_452"})

    return client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": content}],
        extra_headers=headers,
    )


# 1. detect_intent — root span, mints the trace + its name/tags/metadata.
r1 = call(span_detect_intent, None, "gpt-4o-mini", "User asked: plan me a 3-day trip to Lisbon. What's the intent?", mint_trace=True)

# 2. extract_travel_dates — child of call 1.
r2 = call(span_extract_dates, span_detect_intent, "gpt-4o-mini", "Extract travel dates from: 'sometime next month, for 3 days'.")

# 3. search_flights_summary — child of call 1.
r3 = call(span_flights, span_detect_intent, "gpt-4o", "Summarize these flight options: [...]")

# 4. search_hotels_summary — child of call 1.
r4 = call(span_hotels, span_detect_intent, "gpt-4o", "Summarize these hotel options: [...]")

# 5. compose_itinerary — child of call 1, runs after 3 and 4 finish.
r5 = call(
    span_compose,
    span_detect_intent,
    "gpt-4o",
    f"Compose a final itinerary from:\nFlights: {r3.choices[0].message.content}\nHotels: {r4.choices[0].message.content}",
)

print("trace id:", trace_id)
print("final itinerary:\n", r5.choices[0].message.content)

# Equivalent last call using plain `requests` instead of the openai client —
# same headers, same shared trace_id/parent id.
raw = requests.post(
    f"{BASE_URL}/gateway/chat/completions",
    headers={
        "Authorization": f"Bearer {GATEWAY_KEY}",
        "Content-Type": "application/json",
        "x-trace-id": trace_id,
        "x-span-id": str(uuid.uuid4()),
        "x-parent-span-id": span_detect_intent,
    },
    json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "One-line summary of the itinerary above."}],
    },
)
print("raw requests call status:", raw.status_code)
print(raw.json()["choices"][0]["message"]["content"])
