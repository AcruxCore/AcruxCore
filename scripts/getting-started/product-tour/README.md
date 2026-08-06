# Product Tour Scripts

Runnable scripts for the [Product tour](https://docs.acruxcore.com/docs/getting-started/product-tour)
getting-started page — the rest of the loop after Quickstart: a tool call, streaming
and non-streaming, reading a trace back, and submitting feedback.

## Prerequisites

- An Acrux Core API key and base URL
- The `support-model` model and the `support-reply` prompt from
  [Quickstart](https://docs.acruxcore.com/docs/getting-started/quickstart), already
  set up in the dashboard
- Python 3.9+ (`pip install acruxcore httpx`) and/or Node 18+
  (`npm install @acruxcoreai/sdk zod`) and/or `curl`

## Setup

```bash
export ACRUXCORE_API_KEY=<your personal api key>
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
```

## Run

```bash
python python/run_tour.py
node typescript/run_tour.mjs
bash bash/run_tour.sh
```

## Expected output

Each script declares (or, for bash, assumes) the `get_weather` tool, calls
`support-model` non-streaming and then streaming, reads the resulting trace back,
and submits feedback on it. The Python and Node versions declare `get_weather` with
the SDK decorator and run it through the tool-calling loop; curl has no decorator
equivalent, so the bash version starts from a plain call and extracts the trace id
from the `x-gateway-trace-id` response header instead. Evaluation (building a
dataset from feedback and running an experiment) is dashboard-only in this tour and
isn't scripted here — see
[Evaluate a prompt against a dataset](https://docs.acruxcore.com/docs/guides/evaluate-a-prompt)
for the SDK/curl path to that.
