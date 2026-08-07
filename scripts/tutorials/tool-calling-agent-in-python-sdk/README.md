# Tool-Calling Agent in Python (SDK) Tutorial

Runnable scripts for the [Build a tool-calling agent in Python (SDK)](https://docs.acruxcore.com/docs/tutorials/build-a-tool-calling-agent-in-python-sdk) tutorial — a text-to-SQL data analyst driven by the SDK's `run_tool_loop`.

## Prerequisites

- An AcruxCore API key and base URL
- The `gpt-4o-mini` model, the `query_database` tool, and the `sql-analyst-agent` prompt, all created via the tutorial's Steps 2–4
- Python 3.9+ (`pip install acruxcore`)

## Setup

```bash
export ACRUXCORE_API_KEY=<your personal api key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
```

## Run

```bash
cd python
python seed_db.py                       # one-time: creates store.db
python sql_agent_decorator_tool.py       # Option A: @acrux.tool decorator
python sql_agent_dispatch.py             # Option B: tool_defs + dispatch — same result, different wiring
python stream_demo.py                    # streaming, no tools
```

## Expected output

Both `sql_agent_*.py` scripts answer "Which product generated the most total
revenue?" and "How many total units were ordered in June 2026?" by writing and
running real SQL against `store.db`, landing both questions in the same
`sql-agent-demo` session. `stream_demo.py` streams a plain-text answer live.
