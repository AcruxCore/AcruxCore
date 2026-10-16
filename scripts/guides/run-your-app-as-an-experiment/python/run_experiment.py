"""Run your own app as an AcruxCore experiment -- Python.

The app is a two-step support-ticket triage:
  1. a model call classifies the ticket (billing, bug, question or account);
  2. plain code routes the category to a team.

``run_local`` calls the app once per dataset example, scores each answer with two
code scorers, and uploads the results as one run. Run it twice, once per prompt
version, then open Compare per example in the dashboard.

Requires:
  pip install acruxcore

Env:
  ACRUXCORE_API_KEY   -- required, a personal key of an editor (or above)
  ACRUXCORE_BASE_URL  -- required, e.g. https://acruxcore.com/api/v1
  ACRUXCORE_MODEL     -- a model registered under Gateway -> Models, default "gpt-4o-mini"

Run:
  python run_experiment.py v1
  python run_experiment.py v2
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from acruxcore import AcruxCore

MODEL = os.getenv("ACRUXCORE_MODEL", "gpt-4o-mini")
DATASET_NAME = "ticket-triage-demo"
VERSION = sys.argv[1] if len(sys.argv) > 1 else "v1"

# The one thing that changes between the two runs: the classification prompt.
# v1 forgets the `account` category that ROUTES below already knows about.
PROMPTS = {
    "v1": 'Classify the support ticket as billing, bug or question. Reply with JSON: {"category": "..."}',
    "v2": 'Classify the support ticket as billing, bug, question or account. Reply with JSON: {"category": "..."}',
}

# Step 2 of the app is plain code, not a model call.
ROUTES = {"billing": "finance", "bug": "engineering", "question": "support", "account": "support"}


async def demo_dataset(hub: AcruxCore) -> str:
    """Finds the demo dataset, or creates it from ../data/tickets.json on the first run."""
    for dataset in await hub.datasets.list():
        if dataset.name == DATASET_NAME:
            return dataset.id
    examples = json.loads((Path(__file__).parent.parent / "data" / "tickets.json").read_text())
    dataset = await hub.datasets.create(name=DATASET_NAME)
    await hub.datasets.add_examples(dataset.id, examples)
    return dataset.id


# Scorers: plain functions that compare the output with the example's `expected`.
def category_exact(output, expected):
    return output["category"] == expected["category"]


def team_exact(output, expected):
    ok = output["team"] == expected["team"]
    return {"score": 1 if ok else 0, "reason": None if ok else f"expected {expected['team']}, got {output['team']}"}


async def main() -> None:
    async with AcruxCore() as hub:

        async def triage(input, ctx):
            """The app under test. `ctx.trace` puts the model call into this example's trace."""
            reply = await hub.gateway.chat(
                model=MODEL,
                messages=[
                    {"role": "system", "content": PROMPTS[VERSION]},
                    {"role": "user", "content": input["ticket"]},
                ],
                response_format={"type": "json_object"},
                trace=ctx.trace,
            )
            category = json.loads(reply.content or "{}").get("category", "unknown")
            return {"category": category, "team": ROUTES.get(category, "support")}

        result = await hub.experiments.run_local(
            await demo_dataset(hub),
            task=triage,
            scorers=[category_exact, team_exact],
            name=VERSION,
            model=MODEL,
        )

        print(f"run {result.run_id} {result.status}")
        for name, s in result.summary.items():
            print(f"  {name:<14} mean {s.mean:.2f}  passed {round(s.pass_rate * s.count)}/{s.count}")
        for item in result.items:
            failed = [s.name for s in item.scores if s.passed is False]
            if item.error or failed:
                print(f"  ✗ {item.input['ticket'][:60]}  ->  {item.error or json.dumps(item.output, separators=(',', ':'))}")
        print(f"open: {result.url}")


asyncio.run(main())
