"""Runs the vip-support-triage completion with the prompt stored in Agenta.

Agenta keeps the prompt in its registry. This script fetches the revision
deployed to `production`, renders it locally with the Agenta SDK (Jinja2
template format), calls the model through OpenRouter with the OpenAI client,
and traces the call with Agenta's OpenTelemetry setup:
`ag.init()` + `OpenAIInstrumentor` + `@ag.instrument()`, plus
`ag.tracing.store_refs()` to link the trace to the prompt it used.

Compare with `acx_sdk_run.py`, where the render, the model call and the trace
all happen on the AcruxCore server.

Run:
  export AGENTA_API_KEY=...
  export AGENTA_HOST=http://localhost:28080
  export OPENROUTER_API_KEY=sk-or-...
  export AGENTA_APP_SLUG=vip-support-triage     # the app's slug in your project
  python scripts/comparison/agenta-vs-acruxcore/python/ag_trace_run.py

Needs: pip install agenta openai opentelemetry-instrumentation-openai
"""

import json
import os
import sys

for name in ("AGENTA_API_KEY", "AGENTA_HOST", "OPENROUTER_API_KEY"):
    if not os.environ.get(name):
        sys.exit(f"{name} is not set")

import agenta as ag
from agenta.sdk.types import PromptTemplate
from openai import OpenAI
from opentelemetry.instrumentation.openai import OpenAIInstrumentor

APP_SLUG = os.environ.get("AGENTA_APP_SLUG", "vip-support-triage")

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

ag.init()
OpenAIInstrumentor().instrument()

client = OpenAI(api_key=os.environ["OPENROUTER_API_KEY"], base_url="https://openrouter.ai/api/v1")


@ag.instrument()
def triage(variables: dict) -> dict:
    config = ag.ConfigManager.get_from_registry(app_slug=APP_SLUG, environment_slug="production")
    prompt = PromptTemplate(**config["prompt"]).format(**variables)
    kwargs = prompt.to_openai_kwargs()
    # Agenta stores OpenRouter models as "openrouter/<vendor>/<model>"; the
    # OpenAI client talking to openrouter.ai wants "<vendor>/<model>".
    kwargs["model"] = kwargs["model"].removeprefix("openrouter/")
    response = client.chat.completions.create(**kwargs)
    # Without this call the trace carries no link to the prompt it used.
    ag.tracing.store_refs({"application.slug": APP_SLUG, "environment.slug": "production"})
    return {
        "content": response.choices[0].message.content,
        "model": response.model,
        "prompt_tokens": response.usage.prompt_tokens,
        "completion_tokens": response.usage.completion_tokens,
        "trace_url": ag.tracing.get_trace_url(),
    }


if __name__ == "__main__":
    print(json.dumps(triage(VARIABLES), indent=2))
    # Spans are exported in batches; flush before the process exits.
    ag.tracing.tracer_provider.force_flush()
