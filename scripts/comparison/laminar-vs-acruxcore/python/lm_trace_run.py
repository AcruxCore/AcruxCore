"""Sends the vip-support-triage completion to self-hosted Laminar, as a traced agent run.

Contrast with `acx_sdk_run.py`: Laminar has no prompt registry, so the template
cannot be fetched at runtime. The VIP branch and the ticket list are pre-rendered
by hand into a flat string here — the same flattening the prompt itself needed
(see aspect 1 of the post). Laminar's value shows up on the other side instead:
`Laminar.initialize()` auto-instruments the OpenAI client through OpenTelemetry,
and `@observe()` nests the LLM span under a parent span, so the agent's *shape*
is what lands in the trace rather than a single flat call.

Run:
  export OPENAI_API_KEY=sk-...
  export LMNR_PROJECT_API_KEY=...              # Settings -> Project API Keys
  export LMNR_BASE_URL=http://localhost:8000   # self-hosted app-server
  python scripts/comparison/laminar-vs-acruxcore/python/lm_trace_run.py

Needs: pip install lmnr openai
"""

import os
import sys

from lmnr import Laminar, observe
from openai import OpenAI

if not os.environ.get("OPENAI_API_KEY"):
    sys.exit("OPENAI_API_KEY is not set")
if not os.environ.get("LMNR_PROJECT_API_KEY"):
    sys.exit("LMNR_PROJECT_API_KEY is not set")

BASE_URL = os.environ.get("LMNR_BASE_URL", "http://localhost:8000")

# force_http keeps the exporter on the app-server's HTTP port; the lite
# self-hosted stack also exposes gRPC on 8001 if you prefer that.
Laminar.initialize(
    project_api_key=os.environ["LMNR_PROJECT_API_KEY"],
    base_url=BASE_URL,
    http_port=8000,
    grpc_port=8001,
)

# Flattened by hand: Laminar has no template engine, so the `{% if is_vip %}`
# branch and the `{% for ticket in tickets %}` loop are resolved before the call.
SYSTEM_PROMPT = (
    "You are a support triage agent for Acme Corp. "
    "This customer is VIP — prioritize them and skip standard hold times. "
    "Open tickets: - #4821: Billing export button greyed out - #4790: SSO login redirect loop. "
    "Keep the reply under 5 sentences. Be concise and specific."
)
USER_MESSAGE = (
    "Hi, my export button is greyed out again and I have two open tickets already. "
    "Can someone look at this today?"
)

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])


@observe(name="vip_support_triage")
def triage(message: str) -> str:
    """Parent span. The OpenAI call below is auto-instrumented and nests under it."""
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0,
        max_tokens=256,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": message},
        ],
    )
    print(
        f"tokens: {response.usage.prompt_tokens} prompt / "
        f"{response.usage.completion_tokens} completion"
    )
    return response.choices[0].message.content


if __name__ == "__main__":
    print(triage(USER_MESSAGE))
    Laminar.flush()
    Laminar.shutdown()
