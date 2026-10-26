"""Promote the candidate that won the pipeline test: move ``production`` to its version.

The candidate was committed as a version by test_candidate.py, so promoting it moves the
alias to that same version. Nothing new is committed, and the version your app ran is
the version that ships.

Run:
    python promote.py <optimize-run-id> <candidate-label>     # e.g. candidate-A
"""

import asyncio
import sys

from acruxcore import AcruxCore


async def main(run_id: str, label: str) -> None:
    async with AcruxCore() as hub:
        run = await hub.runs.get(run_id)
        cell = next(c for c in run.grid if c["variantLabel"] == label)
        result = await hub.runs.promote_candidate(run_id, cell["promptCandidateId"], alias="production")
        print(f"production -> v{result.version['versionNumber']}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python promote.py <optimize-run-id> <candidate-label>")
    asyncio.run(main(sys.argv[1], sys.argv[2]))
