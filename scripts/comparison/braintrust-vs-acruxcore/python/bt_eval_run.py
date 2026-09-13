"""Evaluate vip-support-triage on Braintrust: a dataset, a task, and two scorers.

Braintrust's centre of gravity. `Eval()` declares the three parts and the CLI runs
every row against every scorer, then writes one experiment you can diff against the
last.

Two scorers on purpose, because they cost different things:

* `mentions_every_ticket` is plain Python -- deterministic, free, and the kind of
  check that should never be an LLM call.
* `Factuality` is an LLM judge from `autoevals`, Braintrust's own scorer library.

One deliberate deviation, and it is a finding rather than a preference: this does
**not** call `prompt.build()`. The stored prompt declares `template_format: nunjucks`
and the Python SDK ignores that field, rendering mustache instead -- which passes the
`{% if %}` blocks through as literal text and silently resolves `{{ ticket.id }}` to an
empty string. Jinja2 is used here to render the template the way the Braintrust web
playground does, so the eval measures the prompt rather than the SDK's rendering bug.

Run:
  export BRAINTRUST_API_KEY=sk-...
  braintrust eval bt_eval_run.py

Needs: pip install 'braintrust[cli]' autoevals openai jinja2
"""

import os
import re
import sys

from autoevals import Factuality
from braintrust import Eval, load_prompt, wrap_openai
from jinja2 import Template
from openai import OpenAI

if not os.environ.get("BRAINTRUST_API_KEY"):
    sys.exit("BRAINTRUST_API_KEY is not set")

PROJECT = "My Project"
PROMPT_SLUG = "vip-support-triage-b124"

client = wrap_openai(
    OpenAI(
        base_url="https://api.braintrust.dev/v1/proxy",
        api_key=os.environ["BRAINTRUST_API_KEY"],
    )
)

DATASET = [
    {
        "input": {
            "company": "Acme Corp",
            "customer_message": (
                "Hi, my export button is greyed out again and I have two open "
                "tickets already. Can someone look at this today?"
            ),
            "is_vip": True,
            "tickets": [
                {"id": "4821", "title": "Billing export button greyed out"},
                {"id": "4790", "title": "SSO login redirect loop"},
            ],
        },
        "expected": "A prioritised reply that names ticket 4821 and ticket 4790.",
    },
    {
        "input": {
            "company": "Acme Corp",
            "customer_message": "The dashboard is slow this morning.",
            "is_vip": False,
            "tickets": [],
        },
        "expected": "A standard-flow reply that does not promise VIP handling.",
    },
    {
        "input": {
            "company": "Acme Corp",
            "customer_message": "Still waiting on my SSO fix, this is urgent.",
            "is_vip": True,
            "tickets": [{"id": "4790", "title": "SSO login redirect loop"}],
        },
        "expected": "A prioritised reply that names ticket 4790.",
    },
]


def mentions_every_ticket(input, output, **_):
    """Fraction of the row's open ticket numbers that appear in the reply.

    Deterministic, so it costs nothing and never disagrees with itself. Rows with no
    open tickets are scored 1 -- there is nothing to miss.
    """
    ids = [ticket["id"] for ticket in input["tickets"]]
    if not ids:
        return 1.0
    found = sum(1 for ticket_id in ids if re.search(rf"\b#?{ticket_id}\b", output or ""))
    return found / len(ids)


class JsList(list):
    """A list that also answers to `.length`.

    The fixture's template asks `{% if tickets and tickets.length %}`. That is valid
    nunjucks, where arrays are JavaScript arrays, and it is silently false in Jinja2,
    where the Pythonic spelling is `tickets | length`. Without this the whole ticket
    block is skipped and every row is told "No open tickets" -- which is exactly the
    kind of quiet difference that makes "both are Jinja2-like" a misleading claim.
    """

    @property
    def length(self) -> int:
        return len(self)


def task(input):
    prompt = load_prompt(project=PROJECT, slug=PROMPT_SLUG)
    variables = {**input, "tickets": JsList(input["tickets"])}
    messages = [
        {"role": message.role, "content": Template(message.content).render(**variables)}
        for message in prompt.prompt_data["prompt"]["messages"]
    ]
    response = client.chat.completions.create(
        model="gpt-4o-mini", messages=messages, temperature=0, max_tokens=256
    )
    return response.choices[0].message.content


Eval(
    PROJECT,
    data=lambda: DATASET,
    task=task,
    scores=[mentions_every_ticket, Factuality],
    experiment_name="vip-support-triage",
)
