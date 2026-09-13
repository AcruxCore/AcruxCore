"""Push `search_flights` to Braintrust as a code tool -- definition AND handler.

This is the Braintrust leg of the tool-ownership comparison. Braintrust stores the
JSON Schema *and* the Python that satisfies it, then runs that Python in its own
serverless runtime. So everything the handler touches has to travel with it: the
flight inventory is inlined below rather than read from `../data/flights.json`,
because Braintrust's bundler ships Python, not data files, and the process that
runs the handler is not on this machine.

That constraint is the finding, not a workaround. Compare `acx_tool_run.py`, where
the same tool's code and data never leave the local process.

Run it:

    pip install braintrust
    export BRAINTRUST_API_KEY=sk-...
    braintrust push scripts/comparison/braintrust-vs-acruxcore/python/bt_tool_push.py
"""

from typing import Any

import braintrust
from pydantic import BaseModel, Field

project = braintrust.projects.create(name="My Project")

# Inlined because the handler runs on Braintrust's infrastructure, not here.
# The same rows as scripts/comparison/braintrust-vs-acruxcore/data/flights.json.
ROUTES: dict[str, list[dict[str, Any]]] = {
    "amsterdam|lisbon": [
        {"flight_no": "KL1693", "airline": "KLM", "depart": "07:20", "arrive": "09:45", "duration": "3h25m", "price_eur": 189},
        {"flight_no": "TP671", "airline": "TAP Air Portugal", "depart": "12:05", "arrive": "14:30", "duration": "3h25m", "price_eur": 154},
        {"flight_no": "HV5171", "airline": "Transavia", "depart": "18:40", "arrive": "21:05", "duration": "3h25m", "price_eur": 118},
    ],
    "amsterdam|tokyo": [
        {"flight_no": "KL861", "airline": "KLM", "depart": "14:35", "arrive": "08:55", "duration": "11h20m", "price_eur": 742},
        {"flight_no": "NH218", "airline": "ANA", "depart": "19:10", "arrive": "13:40", "duration": "11h30m", "price_eur": 815},
    ],
    "amsterdam|reykjavik": [
        {"flight_no": "FI501", "airline": "Icelandair", "depart": "09:15", "arrive": "10:40", "duration": "3h25m", "price_eur": 231},
        {"flight_no": "KL1385", "airline": "KLM", "depart": "16:50", "arrive": "18:15", "duration": "3h25m", "price_eur": 267},
    ],
    "lisbon|barcelona": [
        {"flight_no": "TP1034", "airline": "TAP Air Portugal", "depart": "10:30", "arrive": "13:55", "duration": "2h25m", "price_eur": 96},
        {"flight_no": "VY8471", "airline": "Vueling", "depart": "20:15", "arrive": "23:40", "duration": "2h25m", "price_eur": 74},
    ],
}


class SearchFlightsArgs(BaseModel):
    origin: str = Field(description="Departure city, e.g. Amsterdam")
    destination: str = Field(description="Arrival city, e.g. Lisbon")
    departure_date: str = Field(description="Departure date as YYYY-MM-DD")


def search_flights(origin: str, destination: str, departure_date: str) -> dict[str, Any]:
    """Look up the in-house flight inventory for one route on one date."""
    flights = ROUTES.get(f"{origin.strip().lower()}|{destination.strip().lower()}", [])
    return {
        "origin": origin,
        "destination": destination,
        "departure_date": departure_date,
        "flights": flights,
        "count": len(flights),
    }


project.tools.create(
    handler=search_flights,
    name="search_flights",
    slug="search-flights",
    description="Search the in-house flight inventory for a route on a given date.",
    parameters=SearchFlightsArgs,
    if_exists="replace",
)
