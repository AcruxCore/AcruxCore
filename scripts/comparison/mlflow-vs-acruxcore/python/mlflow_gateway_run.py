"""Runs the vip-support-triage completion through MLflow's Prompt Registry + AI Gateway.

Contrast with `acx_sdk_run.py`: AcruxCore's SDK renders the stored prompt server-side
and the trace (with prompt-version lineage) is written automatically by the gateway,
with no tracing code in that script at all. Here the same two steps are explicit and
client-side: `mlflow.genai.load_prompt()` renders the prompt locally, the rendered
messages are POSTed to MLflow's OpenAI-compatible Gateway endpoint (which writes the
trace and usage-tracking row server-side), and `link_prompt_versions_to_trace()` is a
separate, explicit call to attach the prompt version to that trace after the fact.

Run:
  export MLFLOW_TRACKING_URI=http://localhost:5000
  python scripts/comparison/mlflow-vs-acruxcore/python/mlflow_gateway_run.py

Needs: pip install mlflow==3.15.1 requests
"""

import json
import os
import sys
import time

import requests

import mlflow

TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")
mlflow.set_tracking_uri(TRACKING_URI)

VARIABLES = {
    "company": "Acme Corp",
    "customer_message": (
        "Hi, my export button is greyed out again and I have two open tickets "
        "already. Can someone look at this today?"
    ),
    "is_vip": True,
    "tickets": [
        {"id": "4821", "title": "Billing export button greyed out"},
        {"id": "4790", "title": "SSO login redirect loop"},
    ],
}


def main() -> None:
    prompt = mlflow.genai.load_prompt("prompts:/vip-support-triage@production")
    rendered = prompt.format(**VARIABLES)

    with mlflow.start_span(name="vip-support-triage-gateway-call") as span:
        span.set_inputs(VARIABLES)
        start = time.perf_counter()
        resp = requests.post(
            f"{TRACKING_URI}/gateway/mlflow/v1/chat/completions",
            json={"model": "vip-support-triage", "messages": rendered},
            timeout=30,
        )
        resp.raise_for_status()
        elapsed = time.perf_counter() - start
        result = resp.json()
        span.set_outputs(result)

        trace_id = span.trace_id

    mlflow.flush_trace_async_logging()
    mlflow.MlflowClient().link_prompt_versions_to_trace(
        trace_id=trace_id, prompt_versions=[prompt]
    )

    choice = result["choices"][0]["message"]["content"]
    usage = result["usage"]
    print(
        json.dumps(
            {
                "content": choice,
                "model": result["model"],
                "prompt_tokens": usage["prompt_tokens"],
                "completion_tokens": usage["completion_tokens"],
                "elapsed_s": round(elapsed, 3),
                "trace_id": trace_id,
            },
            indent=2,
        )
    )
    print(f"\nMLflow trace: {TRACKING_URI}/#/experiments/1/traces?selectedEvaluationId={trace_id}")


if __name__ == "__main__":
    main()
