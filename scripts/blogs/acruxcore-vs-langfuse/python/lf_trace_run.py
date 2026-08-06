"""Sends the vip-support-triage completion through Langfuse's OTel-based
OpenAI wrapper, producing a real trace in Langfuse (the Playground alone does
not trace). Requires LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_HOST,
and OPENROUTER_KEY in the environment.
"""

import os

from langfuse import get_client
from langfuse.openai import openai

langfuse = get_client()

client = openai.OpenAI(
    api_key=os.environ["OPENROUTER_KEY"],
    base_url="https://openrouter.ai/api/v1",
)

SYSTEM_PROMPT = (
    "You are a support triage agent for Acme Corp. "
    "This customer is VIP — prioritize them and skip standard hold times. "
    "Open tickets: - #4821: Billing export button greyed out - #4790: SSO login redirect loop "
    "Keep the reply under 5 sentences. Be concise and specific."
)
USER_MESSAGE = (
    "Hi, my export button is greyed out again and I have two open tickets already. "
    "Can someone look at this today?"
)

with langfuse.start_as_current_observation(name="vip-support-triage-request", as_type="span"):
    response = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        temperature=0,
        max_tokens=256,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_MESSAGE},
        ],
        name="vip-support-triage-generation",
    )
    print(response.choices[0].message.content)

langfuse.flush()
