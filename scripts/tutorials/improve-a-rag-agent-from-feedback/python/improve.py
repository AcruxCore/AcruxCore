"""Turn the thumbs-down feedback into a dataset, and let the optimizer rewrite the prompt.

The optimize run drafts rewrites of ``brewline-support`` and scores each one, and the
live version, by replaying every feedback case: it renders the template with the
case's variables and makes one model call. That call has no tools, so the scores say
whether the wording is better, not whether the agent retrieves and looks up the right
things. ``test_candidate.py`` checks that next.

Besides the feedback cases, the dataset gets the regression checks in
``../data/regression_checks.json``: questions the agent already answers well, so a
rewrite that fixes one thing and breaks another loses points.

Run:
    python improve.py
"""

import asyncio
import json
import os
from pathlib import Path

from acruxcore import AcruxCore

from agent import TODAY

PROMPT = "brewline-support"
DATA = Path(__file__).resolve().parent.parent / "data"
MODEL = os.getenv("ACRUXCORE_MODEL", "gpt-4o-mini")
#: A stronger model than the agent's writes the rewrites and grades the answers: it
#: writes more specific instructions and judges more steadily.
STRONG_MODEL = os.getenv("ACRUXCORE_STRONG_MODEL", "gpt-4.1")

#: Graded by the judge as well as read by the optimizer, so it says what a correct
#: answer contains. The tools are named as the way to get there, because the judge sees
#: only the answer, never which tools were called.
OVERALL_FEEDBACK = (
    "A correct answer states the Brewline policy that applies and what it means for this "
    "customer's order (dates, whether the item was used), then the exact next step the "
    "customer must take. It never gives general advice that is not in Brewline's "
    "policies. The policies come from the search_policies tool and the order from the "
    "lookup_order tool."
)


async def thumbs_down_on(hub: AcruxCore, prompt_id: str) -> list[str]:
    """The ids of every thumbs-down left on a trace that ran this prompt.

    Filtered on the server, so feedback on the team's other prompts never becomes an
    example of this one, and read page by page, so none is left out past the first 100.
    """
    ids: list[str] = []
    page = 1
    while True:
        result = await hub.traces.list_feedback(page=page, limit=100, rating="down", prompt_id=prompt_id)
        ids += [f.id for f in result.data]
        if page * result.limit >= result.total:
            return ids
        page += 1


async def main() -> None:
    async with AcruxCore() as hub:
        prompt = next(p for p in (await hub.prompts.list(search=PROMPT)).data if p.name == PROMPT)
        thumbs_down = await thumbs_down_on(hub, prompt.id)
        if not thumbs_down:
            raise SystemExit(f"No thumbs-down feedback on {PROMPT} traces yet. Run leave_feedback.py first.")

        dataset = await hub.datasets.build_from_feedback(
            "brewline-support-misses",
            thumbs_down,
            overall_feedback=OVERALL_FEEDBACK,
        )
        print(f"dataset {dataset.id}: {dataset.example_count} examples from feedback, skipped {dataset.skipped}")

        # Cases the agent already gets right, so a rewrite that breaks them loses points.
        checks = json.loads((DATA / "regression_checks.json").read_text())
        await hub.datasets.add_examples(
            dataset.id,
            [{"input": {"question": c["question"], "today": TODAY}, "criteria": c["criteria"]} for c in checks],
        )
        print(f"+ {len(checks)} regression checks")

        run = await hub.optimize.start(
            prompt.id,
            dataset_id=dataset.id,
            models=[MODEL],
            judge_model=STRONG_MODEL,
            optimizer_model=STRONG_MODEL,
            draft_count=3,
        )
        print(f"optimize run {run.run_id} {run.status}")

        while (detail := await hub.runs.get(run.run_id)).status in ("queued", "running"):
            await asyncio.sleep(3)
        print(f"run {detail.status}")

        report = await hub.runs.get_report(run.run_id)
        candidates = {c["variantLabel"]: c.get("promptCandidateId") for c in detail.grid}
        print("\nvariant        score  passed")
        for key in report.leaderboard:
            cell = next(c for c in report.cells if c["cellKey"] == key)
            passed = round((cell["passRate"] or 0) * cell["scoredCount"])
            print(f"{cell['variantLabel']:<13} {cell['avgScore'] or 0:6.1f}  {passed}/{cell['exampleCount']}")
        print("\ncandidate ids:")
        for label, candidate_id in candidates.items():
            if candidate_id:
                print(f"  {label}: {candidate_id}")
        print(f"\nrun_id={run.run_id}")


if __name__ == "__main__":
    asyncio.run(main())
