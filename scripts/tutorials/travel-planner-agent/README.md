# Travel planner agent

Runnable code for the [Build a travel planner agent](https://docs.acruxcore.com/docs/tutorials/build-a-travel-planner-agent)
tutorial. One prompt, three tools, and a model that decides which of them to call — often
one, sometimes two, and for a general question, none.

The three tools differ in **who runs them**, which is the point of the tutorial:

| Tool | Executor | Who calls the upstream API |
|---|---|---|
| `search_flights` | `client` | your own code, from `data/flights.json` |
| `get_city_weather` | `http` | AcruxCore, server-side |
| `convert_currency` | `http` | AcruxCore, server-side |

## Start here if you are new

`notebook/travel_planner_agent.ipynb` is the whole tutorial as one notebook, written for a
first-timer: a preflight cell that checks a fresh account is actually ready, each tool
created in two steps (shell, then version) with a dashboard screenshot beside the code, a
live read of the traces the runs produced, and four real failure modes triggered on purpose
so you can read the actual error.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install acruxcore jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
jupyter lab notebook/travel_planner_agent.ipynb
```

Every cell is find-or-create, so running it twice is safe.

## The agent as a standalone script

Use these once the setup exists — they are the run step only, not the setup.

| Script | What it does |
|---|---|
| `python/run_agent.py` | Renders the prompt, appends the question, runs the tool loop with one `client_tools` entry. |
| `typescript/run_agent.mjs` | The same, in Node. |

```bash
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1

python python/run_agent.py "Any flights from Amsterdam to Lisbon on 2026-08-28?"
node typescript/run_agent.mjs "Should I pack a raincoat for Lisbon? I land tomorrow."
```

With no argument, either script works through all four demo questions — one needing no
tool, one needing `search_flights`, one needing `get_city_weather`, and one needing two
tools in a single turn.

## Prerequisites

- An AcruxCore account, a personal API key, and the base URL.
- One gateway model whose **public name** is `gpt-4o-mini`, or edit `MODEL` in the notebook
  to match a name from **Gateway → Models** in your dashboard.
- The `travel-planner` prompt and the three tools. The notebook creates all of them; the two
  run scripts assume they already exist.
- Python 3.11+ / Node 18+.
- `client_tools` needs an `acruxcore` newer than 0.9.0. The notebook's preflight cell reports
  whether yours has it.

## What these create in your team

One prompt (`travel-planner`) and three tools (`search_flights`, `get_city_weather`,
`convert_currency`), all find-or-create. The tutorial's screenshots show these exact
objects. `data/flights.json` stands in for the flight inventory your own app would already
own — AcruxCore stores that tool's schema and never its data.
