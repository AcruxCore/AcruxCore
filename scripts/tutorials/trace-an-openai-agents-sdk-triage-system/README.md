# OpenAI Agents SDK Support-Triage Tracing Tutorial

Runnable script for the [Trace an OpenAI Agents SDK Support-Triage System](https://docs.acruxcore.com/tutorials/trace-an-openai-agents-sdk-triage-system) tutorial.

This is **not** an AcruxCore SDK example — it shows that a plain OpenAI Agents
SDK app needs zero code changes to send its traces to AcruxCore. All the
integration is in five lines of standard OpenTelemetry + OpenInference setup at
the top of `triage_system.py`.

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
