# Tool-Calling Agent in Python (No SDK) Tutorial

Runnable scripts for the [Build a tool-calling agent in Python (no SDK)](https://docs.acruxcore.com/docs/tutorials/build-a-tool-calling-agent-in-python-no-sdk) tutorial.

## Start here if you are new

`notebook/weather_agent_rest.ipynb` is the whole tutorial as one notebook, written for a
first-timer: a preflight cell that checks a fresh account is actually ready, the tool created
in two steps (shell, then version) with the dashboard values beside each REST call, the
prompt and its tool binding, the trace read back from the API, and four real failure modes
triggered on purpose — including the quiet one, where forgetting to thread the trace id
splits one run into two traces without raising anything.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install requests jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
jupyter lab notebook/weather_agent_rest.ipynb
```

Every cell is find-or-create, so running it twice is safe. The scripts below are the run
step only — use them once the setup exists.

## Prerequisites

- An AcruxCore API key and base URL (see the tutorial's Step 3)
- A credential + model registered in the dashboard (see the tutorial's Steps 1–2) — an OpenRouter key works for any provider
- Python 3.9+ with `requests` (`pip install requests`)

## Setup

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
```

## Run

```bash
cd python
python weather_agent.py     # one full run, waits for the whole answer
python weather_stream.py    # streams the reply token by token
```

## Expected output

`weather_agent.py` asks for Tokyo's weather, the model calls `get_weather`, and the
final answer reports "22°C with light rain" — one trace with an LLM span, a
`get_weather` tool span, and a final LLM span. `weather_stream.py` prints Paris's
answer live as it streams (no tools — see the tutorial's Step 6 for why).

## Set up the tool and prompt first

`setup_prompt.py` is the runnable version of the page's "Python (SDK)" tab for
Step 4: it creates the `get_weather` tool and the `py-weather-agent` prompt and
connects them. Find-or-create, so re-running it is a no-op. The agent scripts
below use plain `requests` with no SDK; this one setup step is the exception,
because the page offers an SDK tab for it.

```bash
python python/setup_prompt.py
```
