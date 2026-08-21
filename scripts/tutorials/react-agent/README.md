# ReAct Agent Tutorial

Runnable scripts for the [Build a ReAct agent](https://docs.acruxcore.com/docs/tutorials/build-a-react-agent) tutorial — a finance research agent driven by a manual tool-calling loop straight against OpenAI, no gateway.

## Prerequisites

- An AcruxCore API key and base URL
- An OpenAI API key (this tutorial calls OpenAI directly)
- The `finance_research` and `get_todays_date` tools, and the `react-agent-finance` prompt, created via the tutorial's Steps 1–2
- `curl`, `jq` (for the bash version) or Python 3.9+ (for the python version)

## Setup

```bash
export ACRUXCORE_API_KEY=<your personal api key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export OPENAI_API_KEY=sk-...
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
