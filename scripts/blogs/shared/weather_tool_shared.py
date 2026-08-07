"""The one tool and the one agent loop that both platform demos share.

`tool_agent_langsmith.py` and `tool_agent_acruxcore.py` (in scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/) both
import from here, so the two runs differ ONLY in where the LLM call goes and
how the run is traced — never in what the tool does or how the loop is shaped.

The tool is `get_weather(city)`, backed by the public wttr.in JSON endpoint. It
needs no API key, which is what makes it registerable as an AcruxCore `http`
tool executor without also provisioning a secret.

Needs: pip install openai requests langsmith
"""

import json
from typing import Any

import requests

# The model both legs must use. OpenRouter's id; the AcruxCore gateway resolves
# the bare `gpt-4o-mini` to this same OpenRouter connection upstream.
MODEL_OPENROUTER = "openai/gpt-4o-mini"
MODEL_ACRUXCORE = "gpt-4o-mini"

WTTR_URL = "https://wttr.in/{city}"

# The tool schema handed to the model. Identical on both legs — on the AcruxCore
# leg this same JSON Schema is also what gets committed as the tool version's
# `parametersSchema`, so the catalog and the model see one definition.
WEATHER_TOOL_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city. Returns temperature in Celsius, "
        "what it feels like, a text condition, and humidity.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "City name, e.g. 'Lahore' or 'Berlin'.",
                }
            },
            "required": ["city"],
        },
    },
}

# The same tool, expressed as an AcruxCore catalog version. This is the AcruxCore
# counterpart to `get_weather` below: the URL, the argument templating, and the
# response trimming that the platform performs on its side. Kept next to the Python
# function on purpose — the two are two implementations of one contract, and a
# reader comparing platforms should be able to see both without leaving the file.
WEATHER_HTTP_EXECUTOR: dict[str, Any] = {
    "type": "http",
    "url": "https://wttr.in/{{arg.city}}",
    "method": "GET",
    "headers": [],
    "query": [{"name": "format", "value": "j1"}],
    "argMapping": [],
    # Trims wttr.in's ~39KB forecast to the same five fields `get_weather` returns.
    # Runs server-side in a locked-down isolate: no network, no filesystem, 1s budget.
    "responseTransform": (
        "function transform(input) {"
        " const c = input.body.current_condition[0];"
        " return {"
        " location: input.body.nearest_area[0].areaName[0].value,"
        " temp_c: Number(c.temp_C),"
        " feels_like_c: Number(c.FeelsLikeC),"
        " condition: c.weatherDesc[0].value,"
        " humidity_pct: Number(c.humidity)"
        " };"
        " }"
    ),
}

# For a loop that dispatches the tool itself (the SDK's `run_tool_loop`), the honest
# executor is `client`: the catalog owns the contract, `get_weather` below owns the
# body, and `POST /tools/:id/execute` correctly refuses with 422 NOT_EXECUTABLE.
WEATHER_CLIENT_EXECUTOR: dict[str, Any] = {"type": "client"}

SYSTEM_PROMPT = (
    "You are a concise outdoor-activity advisor. When a question depends on the "
    "weather, call get_weather before answering. Answer in at most three sentences "
    "and always state the temperature you based the advice on."
)

QUESTION = "Should I go for a run in Lahore this evening?"


def get_weather(city: str) -> dict[str, Any]:
    """Fetch current weather for a city and shrink wttr.in's payload to four fields.

    The trimming matters for the comparison: it is exactly what the AcruxCore
    tool version does in its `responseTransform`, so both legs feed the model the
    same small JSON instead of wttr.in's ~40KB forecast blob.
    """
    res = requests.get(
        WTTR_URL.format(city=city),
        params={"format": "j1"},
        timeout=20,
    )
    res.raise_for_status()
    payload = res.json()
    current = payload["current_condition"][0]
    # `location` comes from the response, not from the `city` argument, so that this
    # function and the AcruxCore responseTransform (which never sees the arguments)
    # can return byte-identical shapes.
    return {
        "location": payload["nearest_area"][0]["areaName"][0]["value"],
        "temp_c": int(current["temp_C"]),
        "feels_like_c": int(current["FeelsLikeC"]),
        "condition": current["weatherDesc"][0]["value"],
        "humidity_pct": int(current["humidity"]),
    }


def build_messages() -> list[dict[str, Any]]:
    """The opening two messages of the conversation, same on both legs."""
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": QUESTION},
    ]


class ToolCallAccumulator:
    """Reassembles streamed `tool_calls` deltas into whole tool calls.

    Streaming splits one tool call across many SSE frames: the id and function
    name usually arrive in the first frame for a given `index`, then the JSON
    arguments arrive a few characters at a time. Nothing in either platform does
    this for you — it is the caller's job on both legs, which is why it lives in
    the shared module rather than in one of them.
    """

    def __init__(self) -> None:
        self._by_index: dict[int, dict[str, Any]] = {}

    def add(self, deltas: Any) -> None:
        """Fold one frame's `delta.tool_calls` list into the accumulator."""
        for d in deltas or []:
            # The index is what correlates fragments of the SAME call across frames;
            # parallel tool calls are distinguished only by it.
            idx = getattr(d, "index", None) or 0
            slot = self._by_index.setdefault(idx, {"id": None, "name": None, "arguments": ""})
            if getattr(d, "id", None):
                slot["id"] = d.id
            fn = getattr(d, "function", None)
            if fn is not None:
                if getattr(fn, "name", None):
                    slot["name"] = fn.name
                if getattr(fn, "arguments", None):
                    slot["arguments"] += fn.arguments

    def finish(self) -> list[dict[str, Any]]:
        """Return the completed tool calls in index order, arguments parsed."""
        calls = []
        for idx in sorted(self._by_index):
            slot = self._by_index[idx]
            calls.append(
                {
                    "id": slot["id"],
                    "name": slot["name"],
                    "arguments": json.loads(slot["arguments"] or "{}"),
                    "raw_arguments": slot["arguments"],
                }
            )
        return calls


def assistant_tool_call_message(calls: list[dict[str, Any]]) -> dict[str, Any]:
    """Rebuild the assistant turn that a stream never returned as one object.

    A non-streaming call hands back a complete assistant message that can be
    appended to `messages` as-is. After streaming, the caller has to reconstruct
    it from the accumulated fragments before the next turn can reference the
    tool_call ids.
    """
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": c["id"],
                "type": "function",
                "function": {"name": c["name"], "arguments": c["raw_arguments"]},
            }
            for c in calls
        ],
    }


def tool_result_message(tool_call_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Wrap a tool result as the `role: tool` message the next LLM turn reads."""
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": json.dumps(result),
    }
