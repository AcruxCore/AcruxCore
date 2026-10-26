"""Run the whole agent — retrieval and order lookup included — on production and on
the optimizer's candidates, side by side, graded by the same judge.

Each candidate is first committed as a prompt version. No alias moves, so production
keeps serving its version. Then ``compare_local`` runs agent.py's ``ask`` once per
variant, all at the same time. Inside a candidate's variant, every render of
``brewline-support`` returns that candidate's version; agent.py itself does not change.

Run:
    python test_candidate.py <optimize-run-id>                 # every candidate
    python test_candidate.py <optimize-run-id> candidate-B     # only the ones named
"""

import asyncio
import os
import sys

from acruxcore import AcruxCore

from agent import ask

#: The same judge the optimize run used, so the two sets of scores mean the same thing.
JUDGE_MODEL = os.getenv("ACRUXCORE_STRONG_MODEL", "gpt-4.1")


async def main(run_id: str, labels: list) -> None:
    async with AcruxCore() as hub:
        run = await hub.runs.get(run_id)
        candidates = [c for c in run.grid if c.get("promptCandidateId") and (not labels or c["variantLabel"] in labels)]

        variants = {"production": None}
        for cell in candidates:
            committed = await hub.runs.commit_candidate(run_id, cell["promptCandidateId"])
            variants[cell["variantLabel"]] = {committed.prompt_name: committed.version_number}
            print(f"{cell['variantLabel']} -> {committed.prompt_name} v{committed.version_number}")

        async def agent(example_input, ctx):
            answer, _ = await ask(hub, example_input["question"], trace=ctx.trace)
            return answer

        comparison = await hub.experiments.compare_local(
            run.dataset_id,  # the feedback dataset the optimize run graded
            task=agent,
            scorers=[hub.experiments.judge(JUDGE_MODEL)],
            variants=variants,
        )
        print()
        print(comparison)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python test_candidate.py <optimize-run-id> [candidate-label ...]")
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
