"""Get a system prompt from acruxcore, add a user message, call the LLM.

Needs: pip install openai requests
"""

import os

import requests
from openai import OpenAI

BASE_URL = "http://localhost:3001/api/v1"
# Never hardcode credentials — export these before running the example.
API_KEY = os.environ.get("ACRUXCORE_API_KEY", "acx_sk_REPLACE_WITH_YOUR_KEY")  # renders the prompt (any role)
GATEWAY_KEY = os.environ.get(
    "ACRUXCORE_GATEWAY_KEY", "agh_sk_REPLACE_WITH_YOUR_GATEWAY_KEY"
)  # gateway virtual key (OpenAI-compatible)

# 1. Get the system message from acruxcore (renders the stored prompt).
render = requests.post(
    f"{BASE_URL}/prompts/Test/production/render",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"variables": {"name": "Alice"}},
)
system_messages = render.json()["messages"]

# 2. Add a user message and call the LLM through the gateway.
client = OpenAI(api_key=GATEWAY_KEY, base_url=f"{BASE_URL}/gateway")
response = client.chat.completions.create(
    model="Mimo",
    messages=system_messages + [{"role": "user", "content": "Hi"}],
)

print(response.choices[0].message.content)
