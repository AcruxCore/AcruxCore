# Trace a CrewAI Trip-Planning Crew Tutorial

Runnable script for the [Trace a CrewAI Trip-Planning Crew](https://docs.acruxcore.com/tutorials/trace-a-crewai-trip-planner) tutorial.

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
pip install crewai crewai-tools openinference-instrumentation-crewai openinference-instrumentation-openai \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http

python trip_planner.py
```

## Expected output

The crew runs twice, sharing one `session.id`: once to plan a 3-day Lisbon trip, once to
revise it — turn 2's planner sees turn 1's actual itinerary text, not just a description
of it, so the revision is a real edit (day 2 becomes relaxed, a cooking class is added)
rather than a fresh unrelated plan. Both crew outputs print to the console. In AcruxCore,
both runs land as two traces under the same session — each trace shows a `chain` root span
(`Crew.kickoff`), two `agent` spans (Researcher, Planner), two `tool` spans (Tavily
searches), and three `llm` spans (model, token counts, and cost all populated) — with no
tracing code anywhere in the crew itself.
