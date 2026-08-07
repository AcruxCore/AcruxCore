"""Runs the same vip-support-triage completion through OpenAI's Python SDK,
traced by Phoenix's OTel instrumentation (`arize-phoenix-otel` +
`openinference-instrumentation-openai`).

Contrast with `acx_sdk_run.py`: AcruxCore's SDK renders a *stored* prompt
server-side (`hub.prompts.render()`) and the gateway writes the trace with no
tracing code in the caller at all. Phoenix has no stored-prompt-render call in
its Python SDK — the caller renders the Mustache template locally, sends a
plain OpenAI-shaped request, and Phoenix's OTel instrumentor auto-wraps the
OpenAI client to emit the span. The Mustache conditionals/loops used in the
Phoenix Playground UI are reproduced here by hand, in Python, because there is
no server-side render endpoint to call instead.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  python scripts/comparison/phoenix-vs-acruxcore/python/px_trace_run.py

Needs: pip install arize-phoenix-otel openinference-instrumentation-openai openai
Phoenix must be running locally at http://localhost:6006 (or set PHOENIX_COLLECTOR_ENDPOINT).
"""

import json
import os
import sys

from phoenix.otel import register
from openinference.instrumentation.openai import OpenAIInstrumentor
from openai import OpenAI

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
PHOENIX_ENDPOINT = os.environ.get("PHOENIX_COLLECTOR_ENDPOINT", "http://localhost:6006")

if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")

tracer_provider = register(
    endpoint=f"{PHOENIX_ENDPOINT}/v1/traces",
    project_name="vip-support-triage-sdk",
    auto_instrument=False,
)
OpenAIInstrumentor().instrument(tracer_provider=tracer_provider)

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


def render_system_message(variables: dict) -> str:
    """Hand-rolled equivalent of the Mustache template built in the Phoenix Playground.

    Phoenix's Python SDK has no prompt-render call, so this logic — which
    AcruxCore's gateway applies server-side from one stored nunjucks template
    — has to be duplicated here in the caller.
    """
    lines = [f"You are a support triage agent for {variables['company']}."]
    if variables["is_vip"]:
        lines.append("This customer is VIP — prioritize them and skip standard hold times.")
    else:
        lines.append("Standard support flow applies.")
    if variables["tickets"]:
        for ticket in variables["tickets"]:
            lines.append(f"- #{ticket['id']}: {ticket['title']}")
    else:
        lines.append("No open tickets.")
    lines.append("Keep the reply under 5 sentences.")
    lines.append(f'Sign off with "— {variables["company"]} Support".')
    return "\n".join(lines)


def main() -> None:
    client = OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1")

    result = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        messages=[
            {"role": "system", "content": render_system_message(VARIABLES)},
            {"role": "user", "content": VARIABLES["customer_message"]},
        ],
        temperature=0,
        max_tokens=256,
    )

    print(
        json.dumps(
            {
                "content": result.choices[0].message.content,
                "model": result.model,
                "usage": result.usage.model_dump() if result.usage else None,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
