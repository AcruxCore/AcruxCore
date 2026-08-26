# Configurable ReAct Agent Tutorial

Runnable code for the [Build a configurable ReAct agent](https://docs.acruxcore.com/docs/tutorials/build-a-configurable-react-agent)
tutorial — one web-research agent whose model, persona and search depth all change by
swapping a single alias string at call time.

## Start here if you are new

`notebook/web_research_agent.ipynb` is the whole tutorial as one notebook, written for a
first-timer: a preflight cell that checks both gateway models and the Tavily key before
anything else, the tool created in two steps with the dashboard values beside the code, both
prompt versions and both aliases created one step at a time, a side-by-side run of the same
question through `quick` and `deep`, the traces read back to prove which model really
answered, and four real failure modes triggered on purpose — including the big one, where
committing a new version moves no alias so every caller keeps the old behaviour.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install acruxcore requests jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export TAVILY_API_KEY=tvly-...
jupyter lab notebook/web_research_agent.ipynb
```

Every cell is find-or-create, so running it twice is safe.

## Prerequisites

- An AcruxCore API key and base URL
- **Two** gateway models with different public names — the notebook defaults to
  `gemini-flash` and `claude-haiku`; change `QUICK_MODEL` / `DEEP_MODEL` if yours differ
- A [Tavily](https://tavily.com/) API key (the free tier is enough)

## The standalone scripts

Use these once the setup exists — they are the run step only.

| Script | What it does |
|---|---|
| `python/run_agent.py` | the agent via the Python SDK's `run_prompt_with_tools()` |
| `typescript/run_agent.mjs` | the same via the Node SDK's `runPromptWithTools()` |
| `bash/web_research_agent.sh` | the loop written by hand in curl and jq |

Each takes the alias as its first argument:

```bash
python run_agent.py quick "What are people saying about small open-source models?"
python run_agent.py deep  "What are people saying about small open-source models?"
```

Same script, same flags — the model, the persona and the search depth all change because
the first argument did.

## A note on Tavily wrappers

The notebook calls Tavily's REST API (`https://api.tavily.com/search`) directly with
`requests`. The page's Python tab uses `langchain_community`'s `TavilySearchResults`, which
makes the same call but is deprecated and drops the `images` array from its return value
even when images are requested. Calling the endpoint directly needs one dependency instead
of three, and lets the notebook count the image difference between the two search depths.
