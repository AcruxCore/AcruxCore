---
title: "One tool, two platforms: tool-call traces in LangSmith vs Acrux Core"
description: We built the same weather tool twice — once as a traced Python function on LangSmith, once as a versioned Tool Catalog entry on Acrux Core — ran both live on the same model, and counted the code.
slug: tool-calling-traces-langsmith-vs-acruxcore
authors: [acrux]
tags: [comparison, langsmith, tracing, tools, llm-ops]
image: /img/social-card.png
keywords: [langsmith tool calling, tool call tracing, langsmith vs acruxcore, tool catalog, llm tool observability, streaming tool calls]
---

A tool call is where an agent stops being a text generator and starts touching the world.
It is also where tracing earns its keep: when an agent gives a wrong answer, the question
is almost never "what did the model say" — it is "what did the tool return, and how long
did it take".

So we built the same tool twice and ran it for real. Same tool, same question, same model
(`openai/gpt-4o-mini` through OpenRouter on both sides, so nothing hides behind a model
difference). One run traced by **LangSmith**, one by **Acrux Core**. Then we did it again
with streaming, which is where we found a bug in our own product.

Every number and every output below comes from a run we actually executed, and
[all three scripts are at the end of the post](/blog/tool-calling-traces-langsmith-vs-acruxcore#run-it-yourself-the-complete-scripts)
in full.

<!-- truncate -->

## The tool

`get_weather(city)` over the public wttr.in endpoint, trimmed down to five fields — because
the raw response is a 39KB forecast blob and no model needs that:

```json
{"location":"Rehmanpura","temp_c":38,"feels_like_c":33,"condition":"Sunny","humidity_pct":38}
```

Both legs import one shared module for the loop and the question, so the only differences
between them are where the LLM call goes and how the run is traced.

## LangSmith: the tool is a decorated function

On LangSmith a tool is a Python function you own. Tracing is two imports and two decorators:

```python
client = wrap_openai(OpenAI(api_key=..., base_url="https://openrouter.ai/api/v1"))

@traceable(run_type="tool", name="get_weather")
def traced_get_weather(city: str) -> dict:
    return get_weather(city)

@traceable(run_type="chain", name="weather-tool-agent")
def run_agent() -> dict:
    ...
```

`wrap_openai` turns every completion into an `llm` span with token counts. `@traceable`
turns the tool into a `tool` span. That is the entire instrumentation, and it is genuinely
pleasant — you add tracing to code you already wrote without restructuring it.

The resulting trace, from a real run:

```
weather-tool-agent          3.72s   376 tokens
├─ ChatOpenAI               1.83s   145
├─ get_weather              0.60s
└─ ChatOpenAI               1.28s   231
```

## Acrux Core: the tool is a catalog artifact, declared in code

There are two ways a tool gets into Acrux Core, and the choice follows from one question:
**who runs the tool body?** A function in your own code gets an `@acrux.tool` decorator and
runs in your process. An HTTP request to some API gets an `http` executor and the platform
runs it. Either way you end up with the same artifact — a versioned catalog entry with
`production`/`staging` aliases — and neither needs a setup step before the script runs.

This leg uses the second, because the whole point of it is that the platform makes the
outbound call.

### What an `http` executor actually is

It is a **recipe for one HTTP request**, stored on the tool version. Not your code running
somewhere else — there is no code of yours involved at all. It holds four things:

- a **method and URL**, where `{{arg.NAME}}` is filled in from the arguments the model
  produced and `{{secret.NAME}}` from a secret you stored on the team;
- **headers** and **query params**, with the same templating, which is how an API key gets
  attached without ever being in your repo;
- an optional **request transform** — JavaScript that reshapes the arguments into a request
  body;
- an optional **response transform** — JavaScript that reshapes what came back before the
  model sees it.

Both transforms run server-side in a locked-down isolate: no network, no filesystem, a
one-second budget. They can reshape JSON around a call; they cannot *be* the tool.

So where LangSmith's version has a function body, this one has a target URL and a response
transform the platform will run:

```python
WEATHER_HTTP_EXECUTOR = {
    "type": "http",
    "url": "https://wttr.in/{{arg.city}}",       # {{arg.NAME}} interpolates the model's args
    "method": "GET",
    "query": [{"name": "format", "value": "j1"}],
    # Trims wttr.in's ~39KB forecast to the same five fields. Runs server-side in a
    # locked-down isolate: no network, no filesystem, 1s budget.
    "responseTransform": (
        "function transform(input) {"
        " const c = input.body.current_condition[0];"
        " return { location: input.body.nearest_area[0].areaName[0].value,"
        "          temp_c: Number(c.temp_C), feels_like_c: Number(c.FeelsLikeC),"
        "          condition: c.weatherDesc[0].value,"
        "          humidity_pct: Number(c.humidity) };"
        " }"
    ),
}
```

Getting that into the catalog is one call:

```python
catalog = session.post(f"{BASE_URL}/tools/sync", json={
    "name": "get_weather", "description": ...,
    "parametersSchema": ..., "executor": WEATHER_HTTP_EXECUTOR,
}).json()   # → {"toolId", "versionNumber", "committed", "alias"}
```

`POST /tools/sync` is create-or-commit-or-nothing: it creates the tool when the name is new,
commits a version only when the submitted spec differs from the live one, and moves the alias
when it commits. So re-running the script makes one request and changes nothing — which is
what makes it safe at the top of a script rather than a one-off setup step you do in a
terminal and then forget to count.

Once it has run, the same executor is what the dashboard shows for that version — the
dictionary above and this form are the same object:

![The get_weather version http executor in the dashboard: method GET, a URL with an arg placeholder, and a query param](/img/blog/tool-comparison/01-http-executor.png)

![The same version response transform: the JavaScript that trims the wttr.in payload server-side](/img/blog/tool-comparison/02-response-transform.png)

You can author a tool this way instead of posting it — the fields are the same either way,
which is why a tool created by a script stays editable by a teammate who has never opened the
repo.

The script then reads the live schema back out by name, rather than sending the model the
literal it just posted:

```python
resolved = session.post(f"{BASE_URL}/tools/resolve",
                        json={"refs": [{"name": "get_weather"}]}).json()["data"][0]
tool_schema = {"type": "function", "function": resolved["function"]}
```

That round-trip looks redundant in a script that owns both ends, and it is the point of the
catalog: `POST /tools/resolve` returns whatever version the alias points at right now, as an
OpenAI-shaped function definition, plus whether the platform can run it
(`executorType: "http"` here). Promote a new version from the dashboard and the running agent
picks it up on its next call, with no redeploy.

Then, when the model asks for the tool, the split of work is:

1. **You** post the model's arguments to `POST /tools/:id/execute`.
2. **The platform** fills the URL template, makes the request to wttr.in, runs the response
   transform, records a `tool` span, and returns the trimmed result.
3. **You** append that result as a `role: tool` message and call the model again.

Step 2 is the whole difference from the LangSmith leg, where step 2 is a local function call.

The client-side tracing code for this is: none. There is no tracing SDK, no decorator, no
span object. There is one header:

```python
extra_headers = {"x-trace-id": TRACE_ID, "x-trace-name": quote("weather-tool-agent")}
```

and one field on the execute call:

```python
{"arguments": {"city": "Lahore"}, "traceContext": {"traceId": TRACE_ID, "parentSpanId": llm_span_id}}
```

The trace from the real run:

```
weather-tool-agent          3 spans   383 tokens
├─ llm  (openai/gpt-4o-mini)  1.41s   137
│   └─ tool get_weather        721ms         ← executed by the platform
└─ llm  (openai/gpt-4o-mini)  1.09s   246
```

The tool span is where the difference shows up, and it is not the timing:

![The tool span expanded, showing executorType http, the tool version id, and transformApplied](/img/blog/tool-comparison/03-http-tool-span.png)

`executorType: http` says the platform made the call; `transformApplied: true` says the
response was trimmed server-side before the model saw it; and `toolVersionId` names the exact
version that ran. That last one is what a decorated local function cannot tell you — six
months later, a trace from a bad answer still says which definition of the tool produced it.

The timing is not the argument. A hosted gateway sitting next to your provider can be faster
than a laptop in another country, but this run had the API and the client on the same machine,
so 721ms is evidence of nothing except that wttr.in was reachable.

## Counting the code

One rule for this to mean anything: **each script must run on its own**, with no setup done
beforehand in a terminal. The LangSmith scripts pass that trivially — the tool is a function
in the file. The Acrux Core scripts have to register their tool in the catalog first, so
that registration is in the code too, and it counts.

Lines of real code, excluding docstrings, comments, and blank lines:

| | LangSmith | Acrux Core |
|---|---|---|
| Non-streaming agent | **63** | **105** |
| Streaming agent | **83** | **113** |
| Shared registration helper | — | **none** |

**Acrux Core is more code in every mode**, and that is the honest total — there is no helper
hiding off-page. The extra ~40 lines are three things the LangSmith leg does not do: post the
tool spec, resolve the live version back, and call `POST /tools/:id/execute` with a trace
context instead of calling a local function.

The shared module is excluded because both legs import it, and its two one-sided parts are
about the same size: the `get_weather` function the LangSmith leg calls, and the `http`
executor dictionary the Acrux Core leg posts. Read all three files in the toggles at the end
and check the count yourself.

Two of those three are per-tool, not per-agent, and the third disappears entirely if you use
the SDK instead of a raw client. The [SDK comparison](/blog/tool-agent-sdk-langchain-vs-acruxcore)
measures that: `run_tool_loop` takes the same agent to **36 lines against LangChain's 50**.
This post is the hand-rolled floor, not the recommended path.

What Acrux Core buys with those lines is a different ownership model. The LangSmith tool is
a function in one file in one language. The catalog tool is a versioned artifact with
aliases, promotion, server-side execution, and per-version analytics, usable from any
language that can make an HTTP request. Whether that trade is worth it depends entirely on
whether more than one service calls the tool.

## Streaming, and a bug in our own product

Streaming is where tool calling stops being tidy. A streamed tool call arrives in pieces:
the id and function name in one frame, then the JSON arguments a few characters at a time.
Nothing reassembles that for you on **either** platform — we wrote a 28-line accumulator
and both legs import it. If you are writing a streaming agent, budget for this.

Then we ran the streaming Acrux Core leg and the trace was not there.

```
# streamed call, x-trace-id supplied, HTTP 200, content streamed fine
GET /api/v1/traces/33b90f57-…  →  {"error":{"code":"NOT_FOUND"}}
GET /gateway/usage             →  7 requests today   ← every streamed call billed
```

A `stream: true` gateway completion was writing its usage and billing row but **no trace
and no span at all**. The cause was one missing call: `recordGatewaySpan` ran in the
non-streaming `complete()` path and nowhere in the streaming `finalize()` path.

It cascaded, too. Tool execution only joined a caller-supplied trace id if that trace
*already existed*, so with the llm span missing, the tool span was filed into its own
orphan trace named `tool:get_weather` — disconnected from the run it belonged to. And
streamed responses never returned `x-gateway-span-id`, so even a correct trace could not
have been nested under the streamed turn.

Three fixes, all shipped in this release:

1. The streaming path now writes its `llm` span from `finalize`, where usage and cost are
   already known, and reassembles the streamed `tool_calls` so the span payload is not
   empty for a tool-calling turn.
2. `x-gateway-trace-id` and `x-gateway-span-id` are minted before the first chunk and
   flushed with the response headers, so a client loop can nest spans under a streamed turn.
3. `POST /tools/:id/execute` now *creates* a caller-supplied trace id when no such trace
   exists — the same contract `POST /traces` already had — while still refusing another
   team's id.

### Verified in production

We deployed the fix and re-ran the identical streaming script against production. The same
run that produced nothing now produces a trace:

```
weather-tool-agent-stream     3 spans   354 tokens   status ok
├─ llm  (gpt-4o-mini)         788ms    128
├─ tool get_weather            38ms
└─ llm  (gpt-4o-mini)         1124ms   226
```

And the first turn's span payload now carries the tool call that the stream delivered a few
characters at a time:

```json
{"finish_reason": "tool_calls",
 "tool_calls": [{"id":"call_tg7xNQitgMlyknkXoRQwpSoD","type":"function",
                 "function":{"name":"get_weather","arguments":"{\"city\":\"Lahore\"}"}}]}
```

The quickest way to check whether a build has the fix is the response headers: a streamed
completion returns `x-gateway-trace-id` and `x-gateway-span-id` only on the new code.

LangSmith, for its part, traced the streamed run correctly first time: 4 spans, 387 tokens,
same shape as the non-streamed one. Credit where it is due.

:::warning[The honest lesson]
We shipped an observability product that could not observe streaming traffic, and the
billing row kept working, so nothing looked broken. If you run an LLM platform, test your
tracing on the streaming path specifically — it is the default for every chat UI, and a
passing non-streaming test suite tells you nothing about it.
:::

## Costing a model an aggregator renamed

Neither platform priced the first runs we did: LangSmith stored `total_cost: null` and Acrux
Core stored `costUsd: null`, because the model id in the payload was `openai/gpt-4o-mini` — an
OpenRouter-prefixed name that neither price table recognises, even though OpenRouter itself
reported the cost in its usage payload.

Acrux Core prices it now, as the `$0.0000854` in the screenshot above shows, and the reason is
worth knowing: the price lives on the **model you registered in the gateway**, not on the id
the provider returns. You register `gpt-4o-mini` once, with its per-million rates and the
upstream id to call, and every request that names it is priced — whatever the aggregator calls
it upstream. If you route through an aggregator, check where your platform gets prices from,
because matching on the returned id fails exactly when a rename happens.

## Run it yourself: the complete scripts

Three files, exactly as executed. The shared module holds the tool and the loop helpers so the
two legs differ only in where the LLM call goes and how the run is traced; each agent script
then runs on its own with no setup beforehand. The streaming variants are the same shape with
the accumulator wired in.

```bash
pip install openai requests langsmith
export OPENROUTER_API_KEY=sk-or-v1-...     # both legs use the same model, through OpenRouter
export LANGSMITH_API_KEY=lsv2_pt_...       # LangSmith leg
export ACRUXCORE_API_KEY=acx_sk_...        # Acrux Core leg: catalog + tool execute
export ACRUXCORE_GATEWAY_KEY=agh_sk_...    # Acrux Core leg: gateway completions
```

<details>
<summary><strong>weather_tool_shared.py</strong> — the tool, the loop helpers and the streaming accumulator — imported by both legs (119 lines of code)</summary>

```python title="weather_tool_shared.py"
"""The one tool and the one agent loop that both platform demos share.

`examples/tool_agent_langsmith.py` and `examples/tool_agent_acruxcore.py` both
import from here, so the two runs differ ONLY in where the LLM call goes and
how the run is traced — never in what the tool does or how the loop is shaped.

The tool is `get_weather(city)`, backed by the public wttr.in JSON endpoint. It
needs no API key, which is what makes it registerable as an Acrux Core `http`
tool executor without also provisioning a secret.

Needs: pip install openai requests langsmith
"""

import json
from typing import Any

import requests

# The model both legs must use. OpenRouter's id; the Acrux Core gateway resolves
# the bare `gpt-4o-mini` to this same OpenRouter connection upstream.
MODEL_OPENROUTER = "openai/gpt-4o-mini"
MODEL_ACRUXCORE = "gpt-4o-mini"

WTTR_URL = "https://wttr.in/{city}"

# The tool schema handed to the model. Identical on both legs — on the Acrux Core
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

# The same tool, expressed as an Acrux Core catalog version. This is the Acrux Core
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

    The trimming matters for the comparison: it is exactly what the Acrux Core
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
    # function and the Acrux Core responseTransform (which never sees the arguments)
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
```

</details>

<details>
<summary><strong>tool_agent_langsmith.py</strong> — the LangSmith leg (63 lines of code)</summary>

```python title="tool_agent_langsmith.py"
"""Leg 1 of 2: run the shared get_weather agent and trace it to LangSmith.

The tool lives in the script (LangSmith has no tool registry — a tool is a
decorated Python function), and `@traceable(run_type="tool")` is what turns the
call into its own span. `wrap_openai` patches the client so every completion is
an `llm` span with token counts.

Run:
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python examples/tool_agent_langsmith.py

Needs: pip install openai requests langsmith
"""

import json
import os
import sys

from langsmith import traceable
from langsmith.run_helpers import get_current_run_tree
from langsmith.wrappers import wrap_openai
from openai import OpenAI

from weather_tool_shared import (
    MODEL_OPENROUTER,
    WEATHER_TOOL_SCHEMA,
    build_messages,
    get_weather,
    tool_result_message,
)

PROJECT = "weather-tool-agent"

# Tracing is opt-in via env, so set it before the first traced call is made.
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = PROJECT
os.environ["LANGSMITH_PROJECT"] = PROJECT

if not os.environ.get("LANGSMITH_API_KEY"):
    sys.exit("LANGSMITH_API_KEY is not set")
if not os.environ.get("OPENROUTER_API_KEY"):
    sys.exit("OPENROUTER_API_KEY is not set")

# wrap_openai is the whole LLM instrumentation: same client API, every call now
# reports itself to LangSmith as an `llm` run.
client = wrap_openai(
    OpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
    )
)


@traceable(run_type="tool", name="get_weather")
def traced_get_weather(city: str) -> dict:
    """The shared tool, wrapped so LangSmith records it as a `tool` span.

    Nothing about the tool changes — the decorator is the only difference between
    this and calling `get_weather` directly.
    """
    return get_weather(city)


@traceable(run_type="chain", name="weather-tool-agent")
def run_agent() -> dict:
    """Drive the tool-calling loop until the model answers without a tool call.

    Returns the final answer plus the LangSmith root run id, so the caller can
    print a deep link to the trace.
    """
    messages = build_messages()
    tool_calls_made = []

    for _ in range(4):  # generous bound; this conversation needs 2 turns
        completion = client.chat.completions.create(
            model=MODEL_OPENROUTER,
            messages=messages,
            tools=[WEATHER_TOOL_SCHEMA],
        )
        choice = completion.choices[0].message
        messages.append(choice.model_dump(exclude_none=True))

        if not choice.tool_calls:
            run = get_current_run_tree()
            return {
                "answer": choice.content,
                "tool_calls": tool_calls_made,
                "root_run_id": str(run.id) if run else None,
                "trace_id": str(run.trace_id) if run else None,
            }

        for call in choice.tool_calls:
            args = json.loads(call.function.arguments)
            result = traced_get_weather(**args)
            tool_calls_made.append({"name": call.function.name, "args": args, "result": result})
            messages.append(tool_result_message(call.id, result))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(json.dumps(out, indent=2))
    if out["trace_id"]:
        print(f"\nLangSmith project: {PROJECT}")
        print(f"trace id: {out['trace_id']}")
```

</details>

<details>
<summary><strong>tool_agent_acruxcore.py</strong> — the Acrux Core leg (105 lines of code)</summary>

```python title="tool_agent_acruxcore.py"
"""Leg 2 of 2: run the same get_weather agent through Acrux Core.

Two things move off the client compared to the LangSmith leg:

1. The tool is not a local function. It lives in the Tool Catalog as a versioned
   `http` executor, so this script fetches its JSON Schema from the catalog
   instead of declaring one, and calls `POST /tools/:id/execute` to run it.
2. Nothing here creates a span. The gateway writes the `llm` spans and the tool
   executor writes the `tool` span; the client only threads one `x-trace-id`
   through both so they land in the same trace.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...        # catalog reads + tool execute
  export ACRUXCORE_GATEWAY_KEY=agh_sk_...    # gateway completions
  python examples/tool_agent_acruxcore.py

Needs: pip install openai requests
"""

import json
import os
import sys
import uuid
from typing import Any
from urllib.parse import quote

import requests
from openai import OpenAI

from weather_tool_shared import (
    MODEL_ACRUXCORE,
    WEATHER_HTTP_EXECUTOR,
    WEATHER_TOOL_SCHEMA,
    build_messages,
    tool_result_message,
)

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
TRACE_NAME = "weather-tool-agent"

API_KEY = os.environ.get("ACRUXCORE_API_KEY")
GATEWAY_KEY = os.environ.get("ACRUXCORE_GATEWAY_KEY")
if not API_KEY:
    sys.exit("ACRUXCORE_API_KEY is not set")
if not GATEWAY_KEY:
    sys.exit("ACRUXCORE_GATEWAY_KEY is not set")

# One trace id, minted here, carried by every call below. This is the whole
# correlation mechanism — there is no tracing SDK in this script.
TRACE_ID = str(uuid.uuid4())

client = OpenAI(api_key=GATEWAY_KEY, base_url=f"{BASE_URL}/gateway")
session = requests.Session()
session.headers["Authorization"] = f"Bearer {API_KEY}"


def register_tool() -> dict[str, Any]:
    """Define the tool here and reconcile the catalog with it, in one request.

    This is the Acrux Core equivalent of writing `get_weather` in the LangSmith
    example: the whole tool — arguments, target URL, response trimming — is
    declared in `weather_tool_shared` and committed from code, so this script
    needs no prior setup.

    `POST /tools/sync` is create-or-commit-or-nothing: it creates the tool if the
    name is new, commits a version only when the submitted spec differs from the
    live one, and moves the alias when it commits. So re-running this script with an
    unchanged spec makes one request and changes nothing.

    An `http` executor cannot come from `@acrux.tool` — a decorator describes a
    Python function, not a declarative request/response mapping — so this leg still
    posts the spec itself. That is the one registration case the decorator does not
    replace.
    """
    fn = WEATHER_TOOL_SCHEMA["function"]
    res = session.post(
        f"{BASE_URL}/tools/sync",
        json={
            "name": fn["name"],
            "description": fn["description"],
            "parametersSchema": fn["parameters"],
            # `http`: the platform performs the request and the trimming itself.
            "executor": WEATHER_HTTP_EXECUTOR,
            "source": "api",
        },
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


def execute_tool(tool_id: str, arguments: dict[str, Any], parent_span_id: str | None) -> dict[str, Any]:
    """Run the catalog tool server-side, inside the current trace.

    `traceContext` is the only tracing code in this file: it tells the platform
    which trace (and which parent span) to file the `tool` span under. The span
    itself — timing, arguments, result, tool version — is written by the platform.
    """
    body: dict[str, Any] = {
        "arguments": arguments,
        "traceContext": {"traceId": TRACE_ID},
    }
    if parent_span_id:
        body["traceContext"]["parentSpanId"] = parent_span_id

    res = session.post(f"{BASE_URL}/tools/{tool_id}/execute", json=body, timeout=40)
    res.raise_for_status()
    return res.json()


def gateway_headers() -> dict[str, str]:
    """Trace context for a gateway completion.

    `x-trace-name` is free text, so it is percent-encoded — HTTP header values
    must be ISO-8859-1 and the API decodes it back on arrival.
    """
    return {
        "x-trace-id": TRACE_ID,
        "x-trace-name": quote(TRACE_NAME),
        "x-capture-payloads": "true",
    }


def resolve_tool(name: str) -> dict[str, Any]:
    """Read the live schema back out of the catalog, by name.

    The point of the catalog is that it — not this file — is the source of truth for
    what the model is told. `POST /tools/resolve` returns the version the alias
    currently points at, as an OpenAI-shaped function definition, plus whether the
    platform can run it (`executorType: "http"` here).
    """
    res = session.post(f"{BASE_URL}/tools/resolve", json={"refs": [{"name": name}]}, timeout=20)
    res.raise_for_status()
    return res.json()["data"][0]


def run_agent() -> dict[str, Any]:
    """Same loop as the LangSmith leg, against a catalog-registered tool."""
    catalog = register_tool()
    resolved = resolve_tool(WEATHER_TOOL_SCHEMA["function"]["name"])
    tool_schema = {"type": "function", "function": resolved["function"]}
    messages = build_messages()
    tool_calls_made = []

    for _ in range(4):
        # with_raw_response is used only to read x-gateway-span-id back, so the
        # tool span can be parented under the llm turn that requested it.
        raw = client.chat.completions.with_raw_response.create(
            model=MODEL_ACRUXCORE,
            messages=messages,
            tools=[tool_schema],
            extra_headers=gateway_headers(),
        )
        llm_span_id = raw.headers.get("x-gateway-span-id")
        choice = raw.parse().choices[0].message
        messages.append(choice.model_dump(exclude_none=True))

        if not choice.tool_calls:
            return {
                "answer": choice.content,
                "tool_calls": tool_calls_made,
                "trace_id": TRACE_ID,
                "tool_version_used": catalog["versionNumber"],
                "tool_version_committed_now": catalog["committed"],
                "executor_type": resolved["executorType"],
            }

        for call in choice.tool_calls:
            args = json.loads(call.function.arguments)
            executed = execute_tool(catalog["toolId"], args, llm_span_id)
            tool_calls_made.append(
                {
                    "name": call.function.name,
                    "args": args,
                    "result": executed["result"],
                    "server_latency_ms": executed["latencyMs"],
                    "tool_version_id": executed["toolVersionId"],
                }
            )
            messages.append(tool_result_message(call.id, executed["result"]))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(json.dumps(out, indent=2))
    print(f"\nAcrux Core trace: {BASE_URL.replace('/api/v1', '')}/traces/{out['trace_id']}")
```

</details>

## Where this leaves things

If your tool is a Python function in one service and you want tracing today, LangSmith is
less code and less thinking. If the same tool is called by several services, or you need to
change what it does without redeploying the caller, a versioned catalog with server-side
execution is a better fit — and the span telling you which version ran is worth more than
the lines it costs.

We would rather publish the run that found a bug in our own gateway than the one that made
us look good. The three scripts are above in full — run them against your own keys and see.

The [SDK-level comparison](/blog/tool-agent-sdk-langchain-vs-acruxcore) — LangChain's
`create_agent` against the Acrux Core SDK's `run_tool_loop` — measures the same thing one
layer up, where the loop and the registration stop being your problem.

And if you want the step-by-step version of getting a tool into the catalog rather than a
comparison, that is [Build and attach a tool](/docs/guides/build-and-attach-a-tool).
