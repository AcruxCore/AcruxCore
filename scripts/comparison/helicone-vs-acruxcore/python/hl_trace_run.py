"""Sends the vip-support-triage completion directly to OpenRouter, then attempts
to log it to a self-hosted Helicone instance via its manual/custom logging
endpoint (POST /v1/trace/custom/log on the `jawn` service).

This is NOT the request-path proxy Helicone advertises on its Providers page
(Settings > Providers > "Enable for AI Gateway (BYOK)"). That proxy was tried
first and does not work on this self-hosted build:

  - POST /v1/gateway/oai/v1/chat/completions forwards the Authorization header
    verbatim to https://api.openai.com, ignoring any provider key registered
    in Settings > Providers. An OpenRouter key gets OpenAI's own
    "Incorrect API key provided" error back.
  - The generic multi-provider path (POST /v1/gateway/gateway/v1/chat/completions)
    returns HTTP 501 "Not implemented" — confirmed by reading the self-hosted
    jawn service's own compiled source (its GATEWAY handler is a stub).

So this script falls back to Helicone's other documented integration path:
call the provider yourself, then manually log the request/response pair. On
this deployment, THAT also fails — the self-hosted docker-compose ships
without an S3_REGION env var, so the log endpoint 500s constructing its S3
client before it ever reaches ClickHouse. The script prints this real error
rather than hiding it. See aspect 2/3/4 in the blog post for the full story.

Run:
  export OPENROUTER_KEY=sk-or-v1-...
  export HELICONE_API_KEY=sk-helicone-...
  export HELICONE_BASE_URL=http://localhost:8585   # self-hosted jawn service
  python scripts/comparison/helicone-vs-acruxcore/python/hl_trace_run.py

Needs: pip install requests
"""

import json
import os
import sys
import time

import requests

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY")
HELICONE_API_KEY = os.environ.get("HELICONE_API_KEY")
HELICONE_BASE_URL = os.environ.get("HELICONE_BASE_URL", "http://localhost:8585")

if not OPENROUTER_KEY:
    sys.exit("OPENROUTER_KEY is not set")
if not HELICONE_API_KEY:
    sys.exit("HELICONE_API_KEY is not set")

SYSTEM_PROMPT = (
    "You are a support triage agent for Acme Corp. "
    "This customer is VIP — prioritize them and skip standard hold times. "
    "Open tickets: - #4821: Billing export button greyed out - #4790: SSO login redirect loop. "
    "Keep the reply under 5 sentences."
)
USER_MESSAGE = (
    "Hi, my export button is greyed out again and I have two open tickets already. "
    "Can someone look at this today?"
)

body = {
    "model": "openai/gpt-4o-mini",
    "temperature": 0,
    "max_tokens": 256,
    "messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_MESSAGE},
    ],
}

start = time.time()
res = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
    json=body,
    timeout=30,
)
end = time.time()
res.raise_for_status()
data = res.json()
print("Direct OpenRouter completion:")
print(data["choices"][0]["message"]["content"])

log_body = {
    "providerRequest": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "json": body,
        "meta": {},
    },
    "providerResponse": {"json": data, "status": res.status_code, "headers": {}},
    "timing": {
        "startTime": {"seconds": int(start), "milliseconds": int((start % 1) * 1000)},
        "endTime": {"seconds": int(end), "milliseconds": int((end % 1) * 1000)},
    },
}

log_res = requests.post(
    f"{HELICONE_BASE_URL}/v1/trace/custom/log",
    headers={"Authorization": f"Bearer {HELICONE_API_KEY}", "Content-Type": "application/json"},
    json=log_body,
    timeout=30,
)
print(f"\nHelicone manual-log attempt: HTTP {log_res.status_code}")
print(log_res.text[:400])
if log_res.status_code >= 400:
    print(
        "\nThis is the real, reproducible failure documented in the blog post — "
        "self-hosted Helicone's custom logger 500s on a missing S3_REGION env var "
        "in its own docker-compose, before the trace ever reaches ClickHouse."
    )
