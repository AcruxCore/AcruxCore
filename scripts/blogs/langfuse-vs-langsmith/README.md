# Langfuse vs LangSmith: one app on both platforms

These are the scripts behind the blog post "Langfuse vs LangSmith". The same small app runs on
Langfuse Cloud and on LangSmith Cloud. Only the instrumentation differs between the two.

The app is a "scope check and quote" agent for a freelance web developer. A client sends a
message. The agent lists each request, checks it against a signed scope and a rate card, prices
the extra work in plain Python, and writes a reply email. Every model call goes to z.ai
`glm-5.3` through the plain OpenAI SDK. Neither leg uses LangChain at run time.

## Files

| Path | What it holds |
|---|---|
| `data/scope.md` | The signed scope (clauses S1–S7) for a fictional yoga-studio site |
| `data/rate_card.json` | 11 priced extras in USD |
| `data/messages.json` | 30 client messages with the expected items and total |
| `prompts/*.v1.json`, `*.v2.json` | The four chat prompts; v2 exists for extract and classify |
| `python/common.py` | Model, base URL, data loaders. Knows nothing about either platform |
| `python/pipeline.py` | The four steps, with no tracing |
| `python/scoring.py` | Exact-match scorers and the LLM judge |
| `python/langfuse_leg.py` | Langfuse: prompts, dataset, traced app, experiments, review queue |
| `python/langsmith_leg.py` | LangSmith: dataset, traced app, experiments, review queue |
| `python/langsmith_push_prompts.py` | Pushes prompts to LangSmith (needs `langchain-core`) |
| `python/export_*_experiment.py` | Export one experiment's per-message results to JSON |
| `python/diff_runs.py` | Which messages a new run fixed or broke, from two exports |
| `RUNLOG.md` and `records/` | The full log of our run: outputs, exports, screenshots |

In each leg, everything platform-specific sits between the `# --- instrumentation` markers.
That block is 11 lines for Langfuse and 18 for LangSmith (blank lines and comments not counted).

## Setup

Use Python 3.12. Make one virtual environment per leg, so neither SDK sees the other.

```bash
# Langfuse leg
python -m venv .venv-langfuse
.venv-langfuse/bin/pip install langfuse==4.14.1 openai python-dotenv

# LangSmith leg
python -m venv .venv-langsmith
.venv-langsmith/bin/pip install langsmith==0.10.10 openai python-dotenv
# only for pushing prompts:
.venv-langsmith/bin/pip install langchain-core
```

Set these in a `.env` file next to the scripts, or in your shell:

```bash
ZAI_API_KEY=...            # z.ai key
ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4/   # default; the GLM Coding Plan endpoint

LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com             # EU region

LANGSMITH_API_KEY=lsv2_...
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com # EU region
```

## Run the Langfuse leg

Run these from the `python/` folder.

```bash
python langfuse_leg.py push-prompts --version 1 --label production
python langfuse_leg.py push-dataset
python langfuse_leg.py run --id msg-06                 # one traced message
python langfuse_leg.py experiment --name v1            # 30 messages, 3 evaluators
python langfuse_leg.py queue --run v1                  # annotation queue for human review
python langfuse_leg.py push-prompts --version 2 --label candidate --names scope-extract,scope-classify
python langfuse_leg.py experiment --label candidate --only scope-extract,scope-classify --name v2
python langfuse_leg.py live                            # 30 messages as production traffic
```

## Run the LangSmith leg

```bash
python langsmith_push_prompts.py --version 1 --tag production
python langsmith_leg.py push-dataset
python langsmith_leg.py run --id msg-06
python langsmith_leg.py experiment --name v1
python langsmith_leg.py queue --experiment <experiment name printed by the last command>
python langsmith_push_prompts.py --version 2 --tag candidate --names scope-extract,scope-classify
python langsmith_leg.py experiment --tag candidate --only scope-extract,scope-classify --name v2
python langsmith_leg.py live
```

## Things to know

- **Rate limits.** The z.ai Coding Plan answers `429` (code 1302) when about 8 calls run at
  once. Run one leg at a time, or pass `--concurrency 2`.
- **Langfuse experiments need an async task to run in parallel.** `run_experiment` calls the
  task inside its event loop, so a plain `def` task runs items one at a time. The default task
  here is `async` and hands the work to a thread. `--sync` keeps the plain version for
  comparison.
- **LangSmith prompts are stored as LangChain objects.** Pushing one needs `langchain-core`.
  Reading one does not: `pull_messages()` in `langsmith_leg.py` unpacks the stored manifest
  into plain OpenAI messages.
- **Neither platform prices `glm-5.3` for this setup out of the box.** Add a model price in
  each one before you run, or every trace shows a cost of zero. In Langfuse, use Project
  Settings → Model Definitions. In LangSmith, use Settings → Model pricing, with provider
  `openai`.
