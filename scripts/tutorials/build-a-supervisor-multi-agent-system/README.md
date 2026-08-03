# Supervisor Multi-Agent System Tutorial

Runnable scripts for the [Build a Supervisor Multi-Agent System](https://docs.acruxcore.com/tutorials/build-a-supervisor-multi-agent-system) tutorial.

## Prerequisites

- An Acrux Core API key and base URL (see the tutorial's Step 2)
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
pip install acruxcore langchain_community tavily-python yfinance requests

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
