# ReAct Agent Tutorial

Runnable scripts for the [Build a ReAct agent](https://docs.acruxcore.com/docs/tutorials/build-a-react-agent) tutorial — a finance research agent driven by a manual tool-calling loop straight against your model provider, no gateway.

## Start here if you are new

`notebook/react_agent.ipynb` is the whole tutorial as one notebook, written for a first-timer:
a preflight cell that checks the AcruxCore key, the provider key and the Yahoo news endpoint
separately, both tools created in two steps each with the dashboard values beside the calls,
the prompt and its two bindings, the trace read back from the API, and four real failure
modes triggered on purpose — including the quiet one, where skipping the `llm` span leaves a
trace with tool calls and no model turns in it.

It reaches Yahoo Finance with `requests` directly rather than through
`langchain-community`'s wrapper, so it needs one dependency instead of three (see issue #352).

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install requests jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export PROVIDER_API_KEY=sk-...
export PROVIDER_BASE_URL=https://api.openai.com/v1     # or any OpenAI-compatible /v1
export PROVIDER_MODEL=gpt-4o-mini                      # an id that provider serves
jupyter lab notebook/react_agent.ipynb
```

Every cell is find-or-create, so running it twice is safe. The scripts below are the run
step only — use them once the setup exists.

## Prerequisites

- An AcruxCore API key and base URL
- A provider key for any OpenAI-compatible API. Your code makes the completion call, so the
  base URL decides who answers. Verified against OpenAI (`https://api.openai.com/v1`,
  `gpt-4o-mini`), OpenRouter (`https://openrouter.ai/api/v1`,
  `meta-llama/llama-3.3-70b-instruct`) and Anthropic's compatibility endpoint
  (`https://api.anthropic.com/v1`, `claude-haiku-4-5-20251001`)
- The `finance_research` and `get_todays_date` tools, and the `react-agent-finance` prompt, created via the tutorial's Steps 1–2
- `curl`, `jq` (for the bash version) or Python 3.9+ and `pip install requests` (for the
  python version). No LangChain: `finance_research` calls Yahoo's news endpoint directly,
  the same two calls the bash version makes.

## Setup

```bash
export ACRUXCORE_API_KEY=<your personal api key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export PROVIDER_API_KEY=sk-...
export PROVIDER_BASE_URL=https://api.openai.com/v1     # or any OpenAI-compatible /v1
export PROVIDER_MODEL=gpt-4o-mini                      # an id that provider serves
```

## Run

```bash
./bash/react_agent.sh "Is there any recent news on AAPL, and is today a weekday?"
python python/react_agent.py "Is there any recent news on AAPL, and is today a weekday?"
```

## Expected output

The model calls `finance_research` and `get_todays_date`, then answers in plain
language. Every span (both `llm` and `tool`) is reported manually by the script,
since this is the BYO path — there's no gateway to record them for you.

## Set up the prompt first

`setup_prompt.py` is the runnable version of the tutorial's Step 4 Python tab: it
creates the `react-agent-finance` prompt and connects both tools. Find-or-create,
so re-running it is a no-op.

```bash
python python/setup_prompt.py
```
