# Supervisor Multi-Agent System Tutorial

Runnable scripts for the [Build a Supervisor Multi-Agent System](https://docs.acruxcore.com/tutorials/build-a-supervisor-multi-agent-system) tutorial.

## Start here if you are new

`notebook/supervisor_flow.ipynb` is the whole tutorial as one notebook, written for a
first-timer: a preflight cell that checks your key, your Tavily key and — unusually — how each
model's credential was connected, because that decides whether `response_format` works at all;
the four tools and four prompts created step by step with the dashboard route beside the code; a
live read of the single trace both model calls land in; and four real ways to get routing wrong,
triggered on purpose so you can read the actual error.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install acruxcore requests jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export TAVILY_API_KEY=<your Tavily key>
jupyter lab notebook/supervisor_flow.ipynb
```

## Prerequisites

- An AcruxCore API key and base URL (see the tutorial's Step 2)
- A Tavily API key (for `advanced_research` and `basic_research` tools)
- Python 3.11+ or Node 22+

## Setup

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export TAVILY_API_KEY=tvly-...
```

## Python

```bash
cd python
pip install acruxcore tavily-python requests

# Step 3: sync tools to the catalog
python create_tools.py

# Step 4: create prompts (see the tutorial page for the curl commands)

# Step 5: run the supervisor flow
python supervisor_flow.py "Research Tesla (TSLA) latest stock news and tell me if investors should be worried."
python supervisor_flow.py "What are the biggest trends in sustainable packaging for consumer goods in 2026?"
```

## TypeScript / Node

```bash
cd typescript
npm install @acruxcoreai/sdk @langchain/tavily

# Step 4: create prompts (see the tutorial page for the curl commands)

# Step 5: run the supervisor flow
node supervisor_flow.mjs "Research Tesla (TSLA) latest stock news and tell me if investors should be worried."
node supervisor_flow.mjs "What are the biggest trends in sustainable packaging for consumer goods in 2026?"
```

## Bash / curl

```bash
cd bash
# Requires: curl, jq

# Step 4: create prompts (see the tutorial page for the curl commands)

# Step 5: run the supervisor flow
bash supervisor_flow.sh "Research Tesla (TSLA) latest stock news and tell me if investors should be worried."
bash supervisor_flow.sh "What are the biggest trends in sustainable packaging for consumer goods in 2026?"
```

## Expected output

The first question (a finance ticker) should route to `finance_research_agent` and call Yahoo Finance.
The second question (general trends) should route to `general_research_agent` and call Tavily.
Both runs land in one trace.

## Set up the prompts first

`setup_prompts.py` is the runnable version of the page's prompt-creation Python
tab. The page shows the router and the finance subagent then says "Repeat for
general-research-agent and writing-agent…" — this script does all four, so the
whole set really exists. Run it after `create_tools.py`.

Each prompt carries a default model, and the API rejects a version whose model is
not registered for the team, so the script checks the registry up front. Override
with `ACRUXCORE_MODEL` if you named yours something other than
`claude-haiku-direct`.

```bash
python python/setup_prompts.py
```
