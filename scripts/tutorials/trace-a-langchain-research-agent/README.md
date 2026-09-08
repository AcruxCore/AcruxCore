# LangChain Research-Agent Tracing Tutorial

Runnable scripts for the [Trace a LangChain Research Agent](https://docs.acruxcore.com/docs/tutorials/trace-a-langchain-research-agent) tutorial.

This is **not** an AcruxCore SDK example — it shows that a plain LangChain agent needs
zero code changes to send its traces to AcruxCore. All the integration is in one
`register()` call at the top of each script.

The same agent is here twice, in Python and in Node, because LangChain ships in both.
They build the same two tools, ask the same two questions, and produce the same span tree.

## Start here if you are new

`notebook/research_agent.ipynb` is the Python route of this tutorial as one notebook, written for
a first-timer: a preflight cell that prints every instrumentor version (span names come from them,
and change between releases); the two tools and the agent built step by step; a live read of both
turns straight from the API; three real ways to get the wiring wrong, triggered on purpose; and a
failing tool that shows what a degraded run costs you.

Two of those are worth reading even if you skip the rest. Adding the `openai` instrumentor next to
the LangChain one silently produces a **second** trace for every model call, double-counting its
tokens and cost. And a tool that raises stops the whole run in Python but not in Node, where the
agent catches the error, feeds it back to the model and answers anyway — the same broken tool,
loud in one language and silent in the other.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install langchain langchain-openai langchain-tavily \
  "acruxcore[otel]" openinference-instrumentation-langchain jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export OPENAI_API_KEY=<your OpenAI key>
export TAVILY_API_KEY=<your Tavily key>
jupyter lab notebook/research_agent.ipynb
```

## Prerequisites

- An AcruxCore API key (see the tutorial's Step 1)
- An OpenAI API key
- A Tavily API key (the free tier is enough)
- Python 3.10+ for the Python script, Node 20+ for the Node one

## Setup

```bash
export OPENAI_API_KEY=sk-...
export TAVILY_API_KEY=tvly-...
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
```

Both scripts also read a `.env` file. Python's `load_dotenv()` searches upward from the
script; Node's `dotenv/config` only reads the directory you run `node` from.

## Python

```bash
cd python
pip install langchain langchain-openai langchain-tavily \
    "acruxcore[otel]" openinference-instrumentation-langchain

python research_agent.py
```

## Node

```bash
cd typescript
npm install @acruxcoreai/sdk langchain @langchain/openai @langchain/core \
    @langchain/tavily zod dotenv \
    @arizeai/openinference-instrumentation-langchain @arizeai/openinference-core \
    @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base \
    @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
    @opentelemetry/semantic-conventions

node research_agent.mjs
```

`instrument: ['langchain']` needs `@acruxcoreai/sdk` **0.12.0 or newer** — earlier versions
raise `UNKNOWN_INSTRUMENTOR` for that name. On the Python side, `acruxcore` has shipped its
`langchain` instrumentor since 0.11.0.

## Expected output

Turn 1 asks what a hot desk at a named Lisbon coworking space costs, and the agent uses
the Tavily tool to find out. Turn 2, in the same conversation, asks what four people
sharing it for three months would each pay — the system prompt forbids the model from
doing arithmetic itself, so it calls `split_cost`.

Both turns share one `session.id`, so AcruxCore's Sessions view groups them as one
conversation. Each turn's trace shows the full agent → model → tool → model span tree,
with the model name, token counts and computed cost on every LLM span.

Live web search means your prices will differ from the tutorial's. That is the point —
nothing here is a fixture.

The two languages use different session ids (`langchain-research-agent-demo` and
`langchain-research-agent-demo-node`) so you can run both and tell the sessions apart.
