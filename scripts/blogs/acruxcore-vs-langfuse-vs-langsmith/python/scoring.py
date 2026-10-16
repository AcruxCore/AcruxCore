"""Scorers shared by both legs: two exact-match checks in code and one LLM judge."""

import json

from common import MODEL, MODEL_PARAMS, render


def _matches(predicted: dict, expected: dict) -> bool:
    if predicted.get("status") != expected["status"]:
        return False
    if expected["status"] == "in_scope":
        return predicted.get("clause") in expected["clauses"]
    if expected["status"] == "out_of_scope":
        return (predicted.get("rate_item") == expected["rate_item"]
                and int(predicted.get("quantity") or 1) == expected["quantity"])
    return True  # needs_estimate and unclear carry no key


def items_exact(predicted: list[dict], expected: list[dict]) -> bool:
    """True when every expected item has its own matching predicted item and nothing is extra."""
    if len(predicted) != len(expected):
        return False

    def assign(i: int, used: frozenset) -> bool:
        if i == len(expected):
            return True
        return any(j not in used and _matches(predicted[j], expected[i])
                   and assign(i + 1, used | {j}) for j in range(len(predicted)))

    return assign(0, frozenset())


def total_exact(predicted_total, expected_total) -> bool:
    return predicted_total == expected_total


def judge_reply(client, judge_messages: list[dict], message: str, expected: dict, reply: str,
                extra: dict | None = None) -> dict:
    """Ask the judge prompt for PASS or FAIL. Returns {"verdict": ..., "reason": ...}."""
    response = client.chat.completions.create(
        model=MODEL,
        messages=render(judge_messages, message=message,
                        expected_items=json.dumps(expected["items"], indent=1),
                        expected_total=expected["total"], reply=reply),
        response_format={"type": "json_object"},
        **MODEL_PARAMS,
        **(extra or {}),
    )
    return json.loads(response.choices[0].message.content or "{}")
