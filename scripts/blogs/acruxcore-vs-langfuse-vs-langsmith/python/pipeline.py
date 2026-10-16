"""The scope-check app with no tracing in it.

Each leg passes in three things, and those are the only places the legs differ:

- get_prompt(name) -> (messages, extra): the prompt's chat messages with {{variable}}
  placeholders, plus extra keyword arguments for chat.completions.create (a leg uses these to
  link the model call to the prompt version).
- client: an OpenAI client, wrapped by the leg so model calls are traced.
- step(name, kind): a decorator factory that turns a function into a traced span.
  kind is "chain" for a step and "tool" for plain code.
"""

import json
from typing import Callable

from common import MODEL, MODEL_PARAMS, load_rate_card, load_scope, render


def no_step(name: str, kind: str) -> Callable:
    return lambda fn: fn


def build_app(get_prompt: Callable, client, step: Callable = no_step) -> Callable:
    scope = load_scope()
    rate_card = load_rate_card()
    rate_card_json = json.dumps(rate_card, indent=1)

    def ask(prompt_name: str, json_out: bool = True, **variables):
        messages, extra = get_prompt(prompt_name)
        kwargs = dict(MODEL_PARAMS)
        if json_out:
            kwargs["response_format"] = {"type": "json_object"}
        response = client.chat.completions.create(
            model=MODEL, messages=render(messages, **variables), **kwargs, **extra
        )
        text = response.choices[0].message.content or ""
        return json.loads(text) if json_out else text

    @step("extract", "chain")
    def extract(message: str) -> list[str]:
        return ask("scope-extract", message=message).get("requests", [])

    @step("classify", "chain")
    def classify(request: str, received: str) -> dict:
        result = ask(
            "scope-classify",
            scope=scope,
            rate_card=rate_card_json,
            received=received,
            request=request,
        )
        return {"request": request, **result}

    @step("price", "tool")
    def price(checked: list[dict]) -> dict:
        """Sum the out-of-scope items from the rate card. The model never does the math."""
        lines, total = [], 0
        for item in checked:
            key = item.get("rate_item")
            if item.get("status") != "out_of_scope" or key not in rate_card["items"]:
                continue
            quantity = int(item.get("quantity") or 1)
            unit_price = rate_card["items"][key]["price"]
            lines.append({"item": key, "quantity": quantity, "unit_price": unit_price,
                          "amount": quantity * unit_price})
            total += quantity * unit_price
        return {"currency": rate_card["currency"], "lines": lines, "total": total}

    @step("reply", "chain")
    def reply(message: str, checked: list[dict], quote: dict) -> str:
        return ask(
            "scope-reply",
            json_out=False,
            message=message,
            checked=json.dumps(checked, indent=1),
            quote=json.dumps(quote, indent=1),
        )

    @step("scope-check", "chain")
    def scope_check(message: str, received: str) -> dict:
        requests = extract(message)
        checked = [classify(r, received) for r in requests]
        quote = price(checked)
        return {"items": checked, "quote": quote, "total": quote["total"],
                "reply": reply(message, checked, quote)}

    return scope_check
