# Trace a CrewAI Trip-Planning Crew Tutorial

Runnable script for the [Trace a CrewAI Trip-Planning Crew](https://docs.acruxcore.com/tutorials/trace-a-crewai-trip-planner) tutorial.

## Start here if you are new

`notebook/trip_planner.ipynb` is the whole tutorial as one notebook, written for a first-timer: a
preflight cell that prints every instrumentor version (span names come from them, and change
between releases); the crew built step by step; a live read of both traces, including the real
search queries the Researcher chose; and four real ways to get the OTLP wiring wrong, triggered on
purpose — two of which produce a trace that looks fine and carries no tokens.

It also uses `await crew.kickoff_async()` rather than `crew.kickoff()`, because a Jupyter kernel
already runs an event loop and CrewAI 1.x refuses a synchronous run from inside one. The script in
`python/` is a plain process, so `kickoff()` is correct there.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install crewai crewai-tools tavily-python 'acruxcore[otel]' \
  openinference-instrumentation-crewai openinference-instrumentation-openai jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export OPENAI_API_KEY=<your OpenAI key>
export TAVILY_API_KEY=<your Tavily key>
jupyter lab notebook/trip_planner.ipynb
```

## Prerequisites

- An AcruxCore API key (see the tutorial's Step 1)
- An OpenAI API key (the crew's model)
- A Tavily API key (the Researcher agent's search tool)
- Python 3.10-3.13 (CrewAI does not yet support 3.14)

## Setup

```bash
export OPENAI_API_KEY=sk-...
export TAVILY_API_KEY=tvly-...
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.acruxcore.com/api/v1/traces/otlp
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer acx_sk_..."
```

Use the signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` variable, not the generic
`OTEL_EXPORTER_OTLP_ENDPOINT` — the OTel spec auto-appends `/v1/traces` to the generic
one, which would misroute the request.

## Python

```bash
cd python
pip install crewai crewai-tools tavily-python \
  openinference-instrumentation-crewai openinference-instrumentation-openai \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http

python trip_planner.py
```

## Expected output

The crew runs twice, sharing one `session.id`: once to plan a 3-day Lisbon trip, once to
revise it — turn 2's planner sees turn 1's actual itinerary text, not just a description
of it, so the revision is a real edit (day 2 becomes relaxed, a cooking class is added)
rather than a fresh unrelated plan. Both crew outputs print to the console. In AcruxCore,
both runs land as two traces under the same session — each trace shows a `chain` root span
for the crew, two `agent` spans (Researcher, Planner), one `tool` span per search the
Researcher decided to run, and three `llm` spans (model, token counts, and cost all
populated) — with no tracing code anywhere in the crew itself.

The exact span names come from `openinference-instrumentation-crewai` and changed between
CrewAI 0.x and 1.x, so read them rather than matching on them.
