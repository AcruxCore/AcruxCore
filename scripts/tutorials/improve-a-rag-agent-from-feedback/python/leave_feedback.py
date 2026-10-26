"""Mark one agent answer as wrong, with a comment that says what right looks like.

In a real team this is a person clicking thumbs-down on the trace in the dashboard.
The script does the same thing over the API.

Run:
    python leave_feedback.py <trace-id> "Wrong. ... Correct answer: ..."
"""

import asyncio
import sys

from acruxcore import AcruxCore


async def main(trace_id: str, comment: str) -> None:
    async with AcruxCore() as hub:
        feedback = await hub.traces.submit_feedback(trace_id, rating=-1, comment=comment)
        print(f"feedback {feedback.id} on trace {trace_id}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit('usage: python leave_feedback.py <trace-id> "comment"')
    asyncio.run(main(sys.argv[1], sys.argv[2]))
