"""Runs the same vip-support-triage completion through Braintrust's Python SDK.

The matched pair for `acx_sdk_run.py`. Both fetch a stored prompt from the
platform, fill the same variables, and send the result to `gpt-4o-mini` served by
OpenRouter, so the downstream call is byte-identical and only the platform
differs.

Two Braintrust-specific details:

* The prompt is pinned to version `c31a45d06acabfcc`, the version whose text
  matches the AcruxCore fixture exactly. A later version exists purely to have
  something to diff, and `load_prompt` would otherwise pick it up.
* Tracing needs two explicit steps -- `init_logger()` to name the destination and
  `wrap_openai()` to instrument the client. Nothing is recorded without both.

Run:
  export BRAINTRUST_API_KEY=sk-...
  python bt_sdk_run.py

Needs: pip install 'braintrust[cli]' openai
"""

import json
import os
import sys

from braintrust import init_logger, load_prompt, wrap_openai
from openai import OpenAI

if not os.environ.get("BRAINTRUST_API_KEY"):
    sys.exit("BRAINTRUST_API_KEY is not set")

PROJECT = "My Project"
PROMPT_SLUG = "vip-support-triage-b124"
PROMPT_VERSION = "c31a45d06acabfcc"

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
    logger = init_logger(project=PROJECT)

    prompt = load_prompt(project=PROJECT, slug=PROMPT_SLUG, version=PROMPT_VERSION)
    built = prompt.build(**VARIABLES)

    # The Braintrust AI proxy resolves `gpt-4o-mini` against the org's configured
    # OpenRouter key, so this is the same downstream model AcruxCore's gateway calls.
    client = wrap_openai(
        OpenAI(
            base_url="https://api.braintrust.dev/v1/proxy",
            api_key=os.environ["BRAINTRUST_API_KEY"],
        )
    )

    with logger.start_span(name="vip-support-triage") as span:
        response = client.chat.completions.create(
            **{**built, "temperature": 0, "max_tokens": 256}
        )
        span_id = span.id

    print(
        json.dumps(
            {
                "content": response.choices[0].message.content,
                "model": response.model,
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "span_id": span_id,
            },
            indent=2,
        )
    )
    logger.flush()


if __name__ == "__main__":
    main()
