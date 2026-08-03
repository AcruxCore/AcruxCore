"""Bundle 5 gateway calls into ONE trace using only x-trace-id (no span/parent
ids). They show up as one waterfall, positioned by real start/end time, but
flat — no parent/child indentation.

T9 demo: trace name/tags/metadata and span name/tags/metadata can now be set
on ANY call sharing the trace, not just the one that creates it.

- Trace name: last-explicit-write-wins. A call that supplies x-trace-name
  renames the trace; a call that omits it leaves the current name alone.
  Below: call 1 sets no name (trace starts on its timestamp fallback), call 2
  names it "trip-planner-draft", call 3 leaves it alone, call 4 renames it
  again to "trip-planner-final", call 5 leaves it alone — the trace ends up
  named "trip-planner-final".
- Trace tags/metadata: merge (union tags, shallow-merge metadata) across
  every call that supplies them — unchanged from T8.
- Span name/tags/metadata: per-call, since every call mints exactly one new
  span — no merge ambiguity. Calls 1-4 give their span a custom name; call 5
  gives none, so that span's name falls back to its own start timestamp.

x-trace-id already works today; nothing new needed for this script's grouping.

Needs: pip install openai requests
"""

import json
import os
import uuid

from openai import OpenAI

BASE_URL = "http://localhost:3001/api/v1"
GATEWAY_KEY = os.environ.get("ACRUXCORE_GATEWAY_KEY", "agh_sk_REPLACE_WITH_YOUR_GATEWAY_KEY")

client = OpenAI(api_key=GATEWAY_KEY, base_url=f"{BASE_URL}/gateway")

# One id, shared by all 5 calls — that's the whole mechanism.
trace_id = str(uuid.uuid4())


def call(
    model: str,
    content: str,
    trace_name: str | None = None,
    trace_tags: list[str] | None = None,
    trace_metadata: dict | None = None,
    span_name: str | None = None,
    span_tags: list[str] | None = None,
    span_metadata: dict | None = None,
):
    headers = {"x-trace-id": trace_id}
    if trace_name:
        headers["x-trace-name"] = trace_name
    if trace_tags:
        headers["x-trace-tags"] = ",".join(trace_tags)
    if trace_metadata:
        headers["x-trace-metadata"] = json.dumps(trace_metadata)
    if span_name:
        headers["x-span-name"] = span_name
    if span_tags:
        headers["x-span-tags"] = ",".join(span_tags)
    if span_metadata:
        headers["x-span-metadata"] = json.dumps(span_metadata)

    return client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": content}],
        extra_headers=headers,
    )


# Call 1 — no trace name yet, so the trace mints on its timestamp fallback.
r1 = call(
    "GLM",
    "User asked: plan me a 3-day trip to Lisbon. What's the intent?",
    trace_tags=["prod", "travel-bot"],
    trace_metadata={"tripId": "trip_452"},
    span_name="detect-intent",
)

# Call 2 — first call to actually name the trace.
r2 = call(
    "GLM",
    "Extract travel dates from: 'sometime next month, for 3 days'.",
    trace_name="trip-planner-draft",
    span_name="extract-dates",
)

# Call 3 — no trace name: leaves "trip-planner-draft" alone. Adds trace
# metadata (merges with tripId) and this call's own span tags/metadata.
r3 = call(
    "Mimo",
    "Summarize these flight options: [...]",
    trace_metadata={"userId": "u_789"},
    span_name="summarize-flights",
    span_tags=["flights"],
    span_metadata={"segment": "flights"},
)

# Call 4 — renames the trace again. Last explicit write still wins, even
# over an already-explicit name.
r4 = call(
    "Mimo",
    "Summarize these hotel options: [...]",
    trace_name="trip-planner-final",
    span_name="summarize-hotels",
)

# Call 5 — no trace name (stays "trip-planner-final") and no span name, so
# this span's name falls back to its own start timestamp.
r5 = call(
    "Mimo",
    f"Compose a final itinerary from:\nFlights: {r3.choices[0].message.content}\nHotels: {r4.choices[0].message.content}",
)

print("trace id:", trace_id)
print("final itinerary:\n", r5.choices[0].message.content)
