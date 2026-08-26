# OpenAI Agents SDK Support-Triage Tracing Tutorial

Runnable script for the [Trace an OpenAI Agents SDK Support-Triage System](https://docs.acruxcore.com/tutorials/trace-an-openai-agents-sdk-triage-system) tutorial.

This is **not** an AcruxCore SDK example — it shows that a plain OpenAI Agents
SDK app needs zero code changes to send its traces to AcruxCore. All the
integration is in five lines of standard OpenTelemetry + OpenInference setup at
the top of `triage_system.py`.

## Start here if you are new

`notebook/triage_system.ipynb` is the Python route of this tutorial as one notebook, written for a
first-timer: a preflight cell that prints every instrumentor version (span names come from them,
and change between releases); the two tools and three agents built step by step; a live read of
both turns, with the handoff span shown next to a real tool call so you can see they arrive as the
same span kind; and four real ways to get this wrong, triggered on purpose.

The first of those four is the one worth reading even if you skip the rest: turning off the Agents
SDK's own tracing takes AcruxCore down with it, because that pipeline is the transport rather than
a competing destination. The notebook proves it — zero traces, then one after switching it back.

It renders on GitHub with its saved output, so you can read the whole thing before running
anything. To run it:

```bash
pip install openai-agents 'acruxcore[otel]' \
  openinference-instrumentation-openai-agents jupyterlab
export ACRUXCORE_API_KEY=<your key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
export OPENAI_API_KEY=<your OpenAI key>
jupyter lab notebook/triage_system.ipynb
```

## Prerequisites

- An AcruxCore API key (see the tutorial's Step 1)
- An OpenAI API key
- Python 3.10+

## Setup

```bash
export OPENAI_API_KEY=sk-...
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.acruxcore.com/api/v1/traces/otlp
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer acx_sk_..."
```

## Python

```bash
cd python
pip install openai-agents openinference-instrumentation-openai-agents \
    opentelemetry-sdk opentelemetry-exporter-otlp-proto-http

python triage_system.py
```

## Expected output

Turn 1 ("I was charged twice...") triages to the **Billing** agent, which
calls `check_subscription`. Turn 2, in the same conversation, ("my app keeps
crashing on order #A1234") triages to the **Tech Support** agent, which calls
`lookup_order`. Both turns share one `session.id`, so AcruxCore's Sessions
view groups them as one conversation, and each turn's trace shows the full
Triage → handoff → specialist-agent → tool → LLM span tree.
