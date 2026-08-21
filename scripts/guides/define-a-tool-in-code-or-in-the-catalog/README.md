# Define a tool in code, or in the catalog

Runnable code for the [Define a tool in code or in the catalog](https://docs.acruxcore.com/docs/guides/define-a-tool-in-code-or-in-the-catalog)
guide. Everything here builds the **same weather tool twice** — once with your code owning
its definition, once with the catalog owning it — so the difference is the only variable.

## Start here if you are new

`notebook/define_a_tool.ipynb` is the whole guide as one notebook: both paths, a preflight
cell that checks a fresh account is actually ready to run, a live read of the tool span's
`toolVersionId`, and two of the guide's traps triggered on purpose so you can read the real
error. Run it top to bottom.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install acruxcore jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
jupyter lab notebook/define_a_tool.ipynb
```

## The same thing as three scripts

Use these if you would rather read plain files, or copy one into a project.

| Script | What it shows |
|---|---|
| `python/code_defined_tool.py` | Path A — `@acrux.tool` derives the definition, `tools.sync` publishes it, `tools=[fn]` runs it. The prompt has no tool bound. |
| `python/setup_catalog_tool.py` | The one-time setup for path B, over the API instead of the dashboard: tool shell, version 1 with a `client` executor, prompt, and a binding pinned to v1. |
| `python/catalog_defined_tool.py` | Path B — the definition stays in the catalog; the script supplies one function and a `client_tools` map. |

```bash
pip install acruxcore
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1

python python/code_defined_tool.py        # path A, self-contained
python python/setup_catalog_tool.py       # path B, once
python python/catalog_defined_tool.py     # path B, the run
```

## Prerequisites

- An AcruxCore account, a personal API key, and the base URL.
- One gateway model whose **public name** is `gpt-4o-mini`, or edit `MODEL` / the `model=`
  argument to match a name from **Gateway → Models** in your dashboard.
- Python 3.11+.
- `client_tools` needs an `acruxcore` newer than 0.9.0. Path A works on 0.9.0; path B does
  not. The notebook's preflight cell reports which you have.

## What these create in your team

Two prompts, `weather-brief-code` (no tools bound, on purpose) and `weather-brief-catalog`
(one tool, pinned to v1), plus two tools, `get_weather_code` and `get_weather_catalog`. All
four are find-or-create, so running anything twice is safe. The guide's screenshots show
these exact objects.
