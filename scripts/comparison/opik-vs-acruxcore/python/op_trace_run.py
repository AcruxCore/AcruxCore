"""Sends the vip-support-triage completion through Opik's `track_openai` wrapper,
producing a real trace in self-hosted Opik (the Prompt playground alone does not
trace — confirmed hands-on: running the same call from the Playground left the
project's Logs tab at "No traces yet").

Contrast with `acx_sdk_run.py`: Opik has no runtime "render this stored prompt"
call, so this script inlines the flattened system/user text (the VIP branch and
ticket list were pre-rendered by hand, the same flattening the prompt itself
needed — see aspect 1) and wraps a normal OpenAI client pointed at OpenRouter.
`opik.integrations.openai.track_openai()` patches that client so every
`.chat.completions.create()` call is captured as a trace automatically.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  export OPIK_URL_OVERRIDE=http://localhost:5175/api   # self-hosted Opik, no auth needed
  export OPIK_WORKSPACE=default
  export OPIK_PROJECT_NAME="Default Project"
  python scripts/comparison/opik-vs-acruxcore/python/op_trace_run.py

Needs: pip install opik openai
"""

import os
import sys

from opik.integrations.openai import track_openai
from openai import OpenAI

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")

os.environ.setdefault("OPIK_URL_OVERRIDE", "http://localhost:5175/api")
os.environ.setdefault("OPIK_WORKSPACE", "default")
os.environ.setdefault("OPIK_PROJECT_NAME", "Default Project")

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

client = track_openai(
    OpenAI(api_key=OPENROUTER_KEY, base_url="https://openrouter.ai/api/v1"),
    project_name=os.environ["OPIK_PROJECT_NAME"],
)

response = client.chat.completions.create(
    model="openai/gpt-4o-mini",
    temperature=0,
    max_tokens=256,
    messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_MESSAGE},
    ],
)

print(response.choices[0].message.content)
print(f"\ntokens: {response.usage.prompt_tokens} prompt / {response.usage.completion_tokens} completion")
