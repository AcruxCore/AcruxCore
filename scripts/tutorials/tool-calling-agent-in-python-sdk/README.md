# Tool-Calling Agent in Python (SDK) Tutorial

Runnable scripts for the [Build a tool-calling agent in Python (SDK)](https://docs.acruxcore.com/docs/tutorials/build-a-tool-calling-agent-in-python-sdk) tutorial — a text-to-SQL data analyst driven by the SDK's `run_tool_loop`.

## Start here if you are new

`notebook/sql_analyst_agent.ipynb` is the whole tutorial as one notebook, written for a
first-timer: a preflight cell that checks a fresh account is actually ready, the tool
created in two steps (shell, then version) with the dashboard values beside the code, the
prompt and its tool binding, a live read of the trace the run produced, and four real
failure modes triggered on purpose so you can read the actual error.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install acruxcore jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
jupyter lab notebook/sql_analyst_agent.ipynb
```

Every cell is find-or-create, so running it twice is safe. The scripts below are the run
step only — use them once the setup exists.

## Prerequisites

- An AcruxCore API key and base URL
- The `claude-haiku` model, the `query_database` tool, and the `sql-analyst-agent` prompt, all created via the tutorial's Steps 2–4
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
python sql_agent_client_tools.py         # Option B: client_tools — same result, different wiring
python stream_demo.py                    # streaming, no tools
```

## Expected output

Both `sql_agent_*.py` scripts answer "Which product generated the most total
revenue?" and "How many total units were ordered in June 2026?" by writing and
running real SQL against `store.db`, landing both questions in the same
`sql-agent-demo` session. `stream_demo.py` streams a plain-text answer live.

## Set up the tool and prompt first

`setup_prompt.py` is the runnable version of the page's two Python setup tabs: it
creates the `query_database` tool and the `sql-analyst-agent` prompt and connects
them. Find-or-create, so re-running it is a no-op. Run it after `seed_db.py`.

```bash
python python/setup_prompt.py
```
