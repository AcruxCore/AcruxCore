---
title: "Tool-call traces: LangSmith vs AcruxCore"
description: "One weather agent built twice: a traced Python function on LangSmith and a catalog tool bound to a prompt on AcruxCore. We compare the traces and the code."
slug: tool-calling-traces-langsmith-vs-acruxcore
authors: [acrux]
tags: [llmops-comparison, llm-tracing]
image: /img/social-card.png
keywords: [langsmith tool calling, tool call tracing, langsmith vs acruxcore, tool catalog, llm tool observability, streaming tool calls, run_prompt_with_tools]
last_update:
  date: 2026-10-25
---

A tool call is the point where an agent stops producing text and calls code or an API.
When an agent gives a wrong answer, the first question is usually what the tool returned
and how long it took. A trace of the run has to answer that.

We built the same agent twice and ran both live. The two agents use the same tool, the same
question and the same model: `openai/gpt-4o-mini` through OpenRouter. **LangSmith** traces one run
and **AcruxCore** traces the other. Then we ran both again with streaming.

Every number and every output below comes from those runs. The scripts for both platforms
are [at the end of the post](/blog/tool-calling-traces-langsmith-vs-acruxcore#run-it-yourself-the-complete-scripts)
in full.

We build AcruxCore. We ran every tool ourselves, and the scripts are linked below.

<!-- truncate -->

## Results at a glance

| | LangSmith | AcruxCore |
|---|---|---|
| Lines of code in the agent script | 65 | 19 |
| Lines of code in the streaming agent script | 70 | 25 |
| One-time setup script | none | 45 lines, or none if you use the dashboard |
| Trace of one run | 4 runs, 377 tokens | 3 spans, 381 tokens |
| Cost of one run, as each platform priced it | $0.0000822 | $0.0000846 |
| Who joins a streamed tool call | Your code, with a 41-line accumulator | The SDK |

## The tool

`get_weather(city)` calls the public wttr.in endpoint. The raw response is a 39KB forecast,
so the tool trims it to five fields before the model sees it:

```json
{"location":"Rehmanpura","temp_c":26,"feels_like_c":25,"condition":"Clear ","humidity_pct":34}
```

The LangSmith scripts and the AcruxCore scripts import one shared module. The module holds
the tool, the system prompt and the question. So the two platforms' scripts differ only in
where each piece is stored and how the run is traced.

## LangSmith: the tool is a decorated function

On LangSmith, a tool is a Python function in your code. Tracing it takes two imports and
two decorators:

```python
client = wrap_openai(OpenAI(api_key=..., base_url="https://openrouter.ai/api/v1"))

@traceable(run_type="tool", name="get_weather")
def traced_get_weather(city: str) -> dict:
    return get_weather(city)

@traceable(run_type="chain", name="weather-tool-agent")
def run_agent() -> dict:
    ...
```

`wrap_openai` records every completion as an `llm` run with token counts. `@traceable`
records the tool as a `tool` run. You add both to code you already have, and nothing else
in that code changes. The loop that calls the model, runs the tool and calls the model
again is yours to write.

> **Key point:** On LangSmith, a tool is a Python function in your code. The loop that calls the
> model, runs the tool and calls the model again is yours to write.

The trace from the run:

```
weather-tool-agent          3.28s   377 tokens
├─ ChatOpenAI               1.45s   145
├─ get_weather              0.52s
└─ ChatOpenAI               1.23s   232
```

## AcruxCore: the tool and the prompt are stored on the platform

On AcruxCore, three things that the LangSmith script keeps in Python files are stored on the
platform instead:

- **The tool** is an entry in the Tool Catalog. Each version holds the schema the model
  reads and an executor that says who runs the tool.
- **The prompt** is a versioned prompt. Each version holds the messages and the model it
  runs on.
- **The binding** attaches the tool to the prompt. When the prompt runs, the model can call
  every tool bound to it.

The agent then asks for the prompt by name and runs it.

### The tool: an `http` executor

An executor says who runs the tool body. A `client` executor means your own process runs a
function. An `http` executor means the platform makes an HTTP request for you. This post uses
`http`, so no tool code runs in the agent's process at all.

An `http` executor is a description of one HTTP request, stored on the tool version. It holds
four things:

- a **method and URL**. `{{arg.NAME}}` is filled in from the arguments the model produced,
  and `{{secret.NAME}}` from a secret stored on your team;
- **headers** and **query params**, with the same placeholders, so an API key never sits in
  your repo;
- an optional **request transform**, JavaScript that builds the request body from the
  arguments;
- an optional **response transform**, JavaScript that reshapes the reply before the model
  sees it.

Both transforms run on the server in an isolated sandbox. The sandbox has no network and no
filesystem, and a transform gets one second. So a transform can reshape JSON, but it cannot
make a call of its own.

Where the LangSmith script has a function body, the AcruxCore tool has a URL and a response
transform. You fill them in on the tool's **New version** form in the dashboard, and no code
of yours holds them:

![The get_weather version's http executor in the dashboard: method GET, a URL with an arg placeholder, the format query param, and the response transform](/img/blog/tool-comparison/01-http-executor.png)

### The setup: once per team

The tool, the prompt and the binding are created once, in the dashboard. If you would rather
keep them in code, `setup_acruxcore.py` makes the same calls. It sends the executor from the
form above as a Python dict, and these are its main lines:

```python
tool_id = (await hub.tools.create(name="get_weather")).id
await hub.tools.commit_version(tool_id, parameters_schema=..., executor=WEATHER_HTTP_EXECUTOR,
                               description=...)

prompt_id = (await hub.prompts.create(name="weather-advisor")).id
await hub.prompts.commit_version(prompt_id, model="gpt-4o-mini", messages=[
    {"role": "system", "content": SYSTEM_PROMPT},
    {"role": "user", "content": "Should I go for a run in {{ city }} this evening?"},
])

await hub.prompts.set_tool_binding(prompt_id, tool_id, tool_alias="production")
```

`gpt-4o-mini` here is a model registered in the gateway, and it points at
`openai/gpt-4o-mini` on OpenRouter. The binding follows the tool's own `production` alias,
so the prompt runs whichever tool version that alias points at. The prompt's **Tools** tab
shows the binding:

![The weather-advisor prompt's Tools tab: get_weather is bound by default and follows the tool's production alias, v1](/img/blog/tool-comparison/05-prompt-tool-binding.png)

### The agent: a render and one call

With the setup done, the agent script is two calls:

```python
async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
    rendered = await hub.prompts.render("weather-advisor", "production", {"city": "Lahore"})
    result = await hub.gateway.run_prompt_with_tools(
        rendered, trace={"name": "weather-tool-agent"}
    )
```

The render returns the filled-in messages, the bound model, the bound tools and the id of
the prompt version. `run_prompt_with_tools` reads all four from it and runs the loop. The
script has no tool schema, no system prompt, no model name and no trace id.

When the model asks for `get_weather`, three steps follow:

1. **The SDK** sees that the tool's version has an `http` executor. It posts the model's
   arguments to `POST /tools/:id/execute`, with the current trace id.
2. **The platform** fills in the URL, calls wttr.in, runs the response transform, writes a
   `tool` span and returns the trimmed result.
3. **The SDK** adds the result to the conversation as a `role: tool` message and calls the
   model again.

In the LangSmith script, step 2 is a function call inside your own process.

### The trace

The trace from the run:

```
weather-tool-agent          3 spans   381 tokens   $0.0000846
├─ llm  gpt-4o-mini           1.62s    145
│   └─ tool get_weather         705ms        ← run by the platform
└─ llm  gpt-4o-mini           1.40s    236
```

The tool span records who ran the tool and which version ran:

![The tool span expanded: executorType http, httpStatus 200, the tool version id, transformApplied true, and the input and output](/img/blog/tool-comparison/03-http-tool-span.png)

`executorType: http` says the platform made the call. `transformApplied: true` says the reply
was trimmed on the server before the model saw it. `toolVersionId` names the exact tool
version that ran. Months later, the trace of a bad answer still says which definition of the
tool produced it.

Each `llm` span holds the id of the prompt version it ran and the variables the prompt was
rendered from, here `{"city": "Lahore"}`:

![The first llm span expanded: model openai/gpt-4o-mini, cost $0.0000289, and a link to every trace of this prompt version](/img/blog/tool-comparison/06-llm-span-prompt-version.png)

The link **View traces for this prompt version** lists every run of that version. In the
LangSmith script, the prompt is a string in a Python file, so its trace has no prompt version
to link to.

The 705ms is not a speed result. The API and the client ran on the same machine, so the
number only shows that wttr.in answered.

### Changing a piece without changing the agent

The agent script names only the prompt and its alias. A change to any of the three stored
pieces reaches it without an edit or a redeploy:

- Commit a new tool version and move the tool's `production` alias, and the next render
  binds the new version.
- Commit a new prompt version and move the prompt's `production` alias, and the next render
  returns the new messages and model.
- Bind a second tool to the prompt, and the next render includes it.

The SDK caches a render for 60 seconds by default, so a change reaches a running agent
within that time.

If the tool body is a function in your own code, its version gets a `client` executor
instead. You pass the function by the tool's name, and the SDK runs it:

```python
result = await hub.gateway.run_prompt_with_tools(
    rendered, client_tools={"get_weather": get_weather}
)
```

The tool span then says `executorType: client`, and it still names the tool version.
[Call a prompt's tools from the SDK](https://docs.acruxcore.com/docs/guides/call-a-prompts-tools-from-the-sdk) covers
both executors.

## Counting the code

Lines of code, without docstrings, comments and blank lines:

| | LangSmith | AcruxCore |
|---|---|---|
| Agent | **65** | **19** |
| Streaming agent | **70** | **25** |
| One-time setup | none | **45**, or none if you use the dashboard |

Add the setup to the AcruxCore agent, and the two platforms are close: 65 lines on LangSmith
and 64 on AcruxCore. On LangSmith, the loop, the tracing and the tool are in every agent
script. On AcruxCore, the setup runs once per team, and each agent script holds a render
and one call.

> **Key point:** Counting AcruxCore's one-time setup, the code is 65 lines on LangSmith and 64 on
> AcruxCore. The 45-line AcruxCore setup runs once per team, not in every agent script.

The shared module is not counted, because scripts on both platforms import it. Three parts
of the module are used by one platform only. The `get_weather` function is used only by the
LangSmith scripts, and the `http` executor only by the AcruxCore setup. The streaming
accumulator is used only by the LangSmith streaming script. It adds 41 lines that the 70 in
the table do not include. All six files are in the toggles at the end, so you can check the
counts.

The [SDK comparison](/blog/tool-agent-sdk-langchain-vs-acruxcore) builds the same agent with
LangChain's `create_agent` and with the AcruxCore SDK's `run_tool_loop`.

## Streaming tool calls

A streamed tool call arrives in pieces. The id and the function name come in one frame, and
the JSON arguments come a few characters at a time. A loop has to put the pieces back
together before it can run the tool.

On LangSmith, that is the caller's job. `wrap_openai` traces the stream, but it does not
hand an assembled tool call back to your code. The LangSmith streaming script joins the
pieces with a 41-line accumulator and rebuilds the assistant message before it runs the
tool. LangSmith recorded the streamed agent as 4 runs and 370 tokens, the same shape as
without streaming.

On AcruxCore, streaming is one argument on the same call:

```python
events = await hub.gateway.run_prompt_with_tools(rendered, stream=True)
async for event in events:
    if event.type == "content":
        print(event.delta, end="", flush=True)
    elif event.type == "tool_call":
        print(f"[calling {event.name}({event.arguments})]")
```

The SDK joins the pieces of the tool call, runs the tool and starts the next round. The
caller receives four kinds of typed events: `content`, `tool_call`, `tool_result` and `done`. The output of
the streamed run:

```
[calling get_weather({'city': 'Lahore'})]
[get_weather returned {'location': 'Rehmanpura', 'temp_c': 26, 'feels_like_c': 25, 'condition': 'Clear ', 'humidity_pct': 34}]
The temperature in Lahore is currently 26°C and feels like 25°C with clear conditions. It would be comfortable for a run this evening. Enjoy your workout!
```

The streamed run produces the same trace as the run without streaming:

```
weather-tool-agent-stream     3 spans   370 tokens   status ok
├─ llm  gpt-4o-mini           1.85s    145
│   └─ tool get_weather         701ms
└─ llm  gpt-4o-mini           1.59s    225
```

The gateway also joins the pieces before it writes the `llm` span. So the first round's span
holds the whole call, although the stream delivered the arguments in pieces:

```json
{"finish_reason": "tool_calls",
 "tool_calls": [{"id":"call_M3O6stziKo3NVWoAe01dc7FN","type":"function",
                 "function":{"name":"get_weather","arguments":"{\"city\":\"Lahore\"}"}}]}
```

## Cost

Both platforms priced every call. LangSmith priced its run at $0.0000822, and AcruxCore
priced its run at $0.0000846. The two runs used 377 and 381 tokens.

AcruxCore takes the price from the model you register in the gateway, not from the model id
the provider returns. Here `gpt-4o-mini` is registered with `openai/gpt-4o-mini` as the
upstream id. Its rates are $0.15 per million input tokens and $0.60 per million output
tokens, and every request that names it is priced at those rates.

## Run it yourself: the complete scripts

Six files, exactly as executed. The shared module holds the code that the other scripts
import. Run `setup_acruxcore.py` once before the AcruxCore agents, or create the same tool,
prompt and binding in the dashboard. The scripts are in the repo under
[`scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/`](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore)
and [`scripts/blogs/shared/`](https://github.com/AcruxCore/AcruxCore/tree/main/scripts/blogs/shared).

```bash
pip install acruxcore openai requests langsmith
export OPENROUTER_API_KEY=sk-or-v1-...     # LangSmith scripts: the model, via OpenRouter
export LANGSMITH_API_KEY=lsv2_pt_...       # LangSmith scripts: tracing
export ACRUXCORE_API_KEY=acx_sk_...        # AcruxCore scripts: all calls
```

On AcruxCore, register `gpt-4o-mini` under **Gateway → Models** first, pointing at
`openai/gpt-4o-mini` on an OpenRouter credential.

<details>
<summary><strong>weather_tool_shared.py</strong>: the tool, the system prompt, the question and the streaming accumulator, imported by both legs (119 lines of code)</summary>

```python title="weather_tool_shared.py"
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
```

</details>

<details>
<summary><strong>tool_agent_langsmith.py</strong>: the LangSmith leg (65 lines of code)</summary>

```python title="tool_agent_langsmith.py"
"""Leg 1 of 2: run the shared get_weather agent and trace it to LangSmith.

The tool lives in the script (LangSmith has no tool registry — a tool is a
decorated Python function), and `@traceable(run_type="tool")` is what turns the
call into its own span. `wrap_openai` patches the client so every completion is
an `llm` span with token counts.

Run:
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/tool_agent_langsmith.py

Needs: pip install openai requests langsmith
"""

import json
import os
import sys

from langsmith import traceable
from langsmith.run_helpers import get_current_run_tree
from langsmith.wrappers import wrap_openai
from openai import OpenAI

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
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
<summary><strong>tool_agent_langsmith_stream.py</strong>: the LangSmith leg, streaming (70 lines of code)</summary>

```python title="tool_agent_langsmith_stream.py"
"""Streaming variant of the LangSmith leg.

Same agent as `tool_agent_langsmith.py`, with `stream=True` on every completion.
A streamed tool call arrives in pieces, so the loop folds the deltas together with
the shared `ToolCallAccumulator` and rebuilds the assistant turn before running the
tool.

Run:
  export LANGSMITH_API_KEY=lsv2_pt_...
  export OPENROUTER_API_KEY=sk-or-v1-...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/tool_agent_langsmith_stream.py

Needs: pip install openai requests langsmith
"""

import json
import os
import sys
from pathlib import Path

from langsmith import traceable
from langsmith.run_helpers import get_current_run_tree
from langsmith.wrappers import wrap_openai
from openai import OpenAI

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from weather_tool_shared import (  # noqa: E402
    MODEL_OPENROUTER,
    WEATHER_TOOL_SCHEMA,
    ToolCallAccumulator,
    assistant_tool_call_message,
    build_messages,
    get_weather,
    tool_result_message,
)

PROJECT = "weather-tool-agent"

os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = PROJECT
os.environ["LANGSMITH_PROJECT"] = PROJECT

if not os.environ.get("LANGSMITH_API_KEY"):
    sys.exit("LANGSMITH_API_KEY is not set")
if not os.environ.get("OPENROUTER_API_KEY"):
    sys.exit("OPENROUTER_API_KEY is not set")

client = wrap_openai(
    OpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url="https://openrouter.ai/api/v1",
    )
)


@traceable(run_type="tool", name="get_weather")
def traced_get_weather(city: str) -> dict:
    """The shared tool, recorded by LangSmith as a `tool` span."""
    return get_weather(city)


@traceable(run_type="chain", name="weather-tool-agent-stream")
def run_agent() -> dict:
    """Drive the streamed tool-calling loop until the model answers without a tool call."""
    messages = build_messages()

    for _ in range(4):
        stream = client.chat.completions.create(
            model=MODEL_OPENROUTER,
            messages=messages,
            tools=[WEATHER_TOOL_SCHEMA],
            stream=True,
            # Without this, a streamed completion reports no token usage.
            stream_options={"include_usage": True},
        )
        acc = ToolCallAccumulator()
        text = ""
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                print(delta.content, end="", flush=True)
                text += delta.content
            acc.add(delta.tool_calls)

        calls = acc.finish()
        if not calls:
            run = get_current_run_tree()
            return {"answer": text, "trace_id": str(run.trace_id) if run else None}

        messages.append(assistant_tool_call_message(calls))
        for call in calls:
            print(f"[calling {call['name']}({call['arguments']})]")
            result = traced_get_weather(**call["arguments"])
            messages.append(tool_result_message(call["id"], result))

    raise RuntimeError("agent did not converge within the turn budget")


if __name__ == "__main__":
    out = run_agent()
    print(f"\n\nLangSmith project: {PROJECT}")
    print(f"trace id: {out['trace_id']}")
```

</details>

<details>
<summary><strong>setup_acruxcore.py</strong>: the one-time AcruxCore setup: tool, prompt and binding (45 lines of code)</summary>

```python title="setup_acruxcore.py"
"""One-time setup for the AcruxCore leg: the tool, the prompt, and the binding.

This is the work the dashboard does when someone fills in the forms, written as code
so the comparison counts it. It runs once per team. The agent scripts never repeat it.

1. Creates the `get_weather` tool and commits version 1 with an `http` executor.
   The platform runs that version: it calls wttr.in and trims the reply itself.
2. Creates the `weather-advisor` prompt and commits version 1, bound to the gateway
   model `gpt-4o-mini`.
3. Binds the tool to the prompt, following the tool's `production` alias.

Find-or-create throughout, so a second run changes nothing.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/setup_acruxcore.py

Needs: pip install acruxcore requests
"""

import asyncio
import os
import sys
from pathlib import Path

from acruxcore import AcruxCore

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from weather_tool_shared import (  # noqa: E402
    MODEL_ACRUXCORE,
    SYSTEM_PROMPT,
    WEATHER_HTTP_EXECUTOR,
    WEATHER_TOOL_SCHEMA,
)

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")
PROMPT_NAME = "weather-advisor"

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        fn = WEATHER_TOOL_SCHEMA["function"]
        found = [t for t in (await hub.tools.list(search=fn["name"])).data if t.name == fn["name"]]
        if found:
            tool_id = found[0].id
        else:
            # Two calls: the tool holds the name, each version holds the schema and executor.
            tool_id = (await hub.tools.create(name=fn["name"])).id
            await hub.tools.commit_version(
                tool_id,
                parameters_schema=fn["parameters"],
                executor=WEATHER_HTTP_EXECUTOR,
                description=fn["description"],
            )

        found = [p for p in (await hub.prompts.list(search=PROMPT_NAME)).data if p.name == PROMPT_NAME]
        prompt_id = found[0].id if found else (await hub.prompts.create(name=PROMPT_NAME)).id
        if (await hub.prompts.list_versions(prompt_id)).total == 0:
            await hub.prompts.commit_version(
                prompt_id,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": "Should I go for a run in {{ city }} this evening?"},
                ],
                model=MODEL_ACRUXCORE,
            )

        # The default binding, so every alias of the prompt calls the tool's production version.
        await hub.prompts.set_tool_binding(prompt_id, tool_id, tool_alias="production")
        print(f"tool {fn['name']} ({tool_id}) is bound to prompt {PROMPT_NAME} ({prompt_id})")


if __name__ == "__main__":
    asyncio.run(main())
```

</details>

<details>
<summary><strong>tool_agent_acruxcore.py</strong>: the AcruxCore leg (19 lines of code)</summary>

```python title="tool_agent_acruxcore.py"
"""Leg 2 of 2: run the same get_weather agent through AcruxCore.

Compared to the LangSmith leg, three things are not in this file:

1. The tool. It is a version in the Tool Catalog with an `http` executor, so the
   platform makes the request to wttr.in and trims the reply.
2. The prompt and the model. They are a version of the `weather-advisor` prompt, and
   the tool is bound to that prompt. `setup_acruxcore.py` creates all three once.
3. The tracing. The gateway writes the `llm` spans and the platform writes the `tool`
   span. The SDK puts them in one trace.

What is left is a render and one call.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/setup_acruxcore.py   # once
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/tool_agent_acruxcore.py

Needs: pip install acruxcore
"""

import asyncio
import json
import os
import sys

from acruxcore import AcruxCore

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        # One render returns the messages, the bound model, the bound tools and the
        # prompt version id. run_prompt_with_tools reads all of them from it.
        rendered = await hub.prompts.render("weather-advisor", "production", {"city": "Lahore"})
        result = await hub.gateway.run_prompt_with_tools(
            rendered, trace={"name": "weather-tool-agent"}
        )

    print(json.dumps({"answer": result.content, "iterations": result.iterations,
                      "trace_id": result.trace_id}, indent=2))
    print(f"\nAcruxCore trace: {BASE_URL.replace('/api/v1', '')}/traces/{result.trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
```

</details>

<details>
<summary><strong>tool_agent_acruxcore_stream.py</strong>: the AcruxCore leg, streaming (25 lines of code)</summary>

```python title="tool_agent_acruxcore_stream.py"
"""Streaming variant of the AcruxCore leg.

The same render and the same call as `tool_agent_acruxcore.py`, with `stream=True`.
The SDK assembles the streamed tool call, runs the tool and starts the next round.
The caller receives typed events: `content`, `tool_call`, `tool_result` and `done`.

Run:
  export ACRUXCORE_API_KEY=acx_sk_...
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/setup_acruxcore.py   # once
  python scripts/blogs/tool-calling-traces-langsmith-vs-acruxcore/python/tool_agent_acruxcore_stream.py

Needs: pip install acruxcore
"""

import asyncio
import os
import sys

from acruxcore import AcruxCore

BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "https://acruxcore.com/api/v1")

if not os.environ.get("ACRUXCORE_API_KEY"):
    sys.exit("ACRUXCORE_API_KEY is not set")


async def main() -> None:
    async with AcruxCore(api_key=os.environ["ACRUXCORE_API_KEY"], base_url=BASE_URL) as hub:
        rendered = await hub.prompts.render("weather-advisor", "production", {"city": "Lahore"})
        events = await hub.gateway.run_prompt_with_tools(
            rendered, stream=True, trace={"name": "weather-tool-agent-stream"}
        )
        async for event in events:
            if event.type == "content":
                print(event.delta, end="", flush=True)
            elif event.type == "tool_call":
                print(f"[calling {event.name}({event.arguments})]")
            elif event.type == "tool_result":
                print(f"[{event.name} returned {event.result}]")
            elif event.type == "done":
                trace_id = event.result.trace_id

    print(f"\n\nAcruxCore trace: {BASE_URL.replace('/api/v1', '')}/traces/{trace_id}")


if __name__ == "__main__":
    asyncio.run(main())
```

</details>

## Where to read next

The [SDK comparison](/blog/tool-agent-sdk-langchain-vs-acruxcore) builds the same agent with
LangChain's `create_agent` and with the AcruxCore SDK.

[AcruxCore vs Langfuse vs LangSmith](/blog/acruxcore-vs-langfuse-vs-langsmith) builds one app
on all three platforms and compares prompts, evaluations and price as well as tool calls.
[Langfuse vs LangSmith](/blog/langfuse-vs-langsmith) compares the two hosted platforms on the
same app.

[Create a tool](https://docs.acruxcore.com/docs/guides/create-a-tool) and
[Call a prompt's tools from the SDK](https://docs.acruxcore.com/docs/guides/call-a-prompts-tools-from-the-sdk) show
each AcruxCore step from this post in more detail.
