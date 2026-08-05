"""Answers one question and returns — deliberately WITHOUT calling aclose().

Whether the trace arrives is entirely down to the SDK's ``atexit`` drain, which is the only
thing this fixture exists to prove. Run as a real subprocess by ``test_span_queue.py``: an
in-process test cannot exercise ``atexit``, because pytest's interpreter does not exit —
and the handler's whole job is to drain on a fresh event loop after ``asyncio.run`` has
closed the one the spans were queued on.
"""

import asyncio
import os

import acruxcore as acrux


async def main() -> None:
    hub = acrux.AcruxCore(
        api_key=os.environ["FIXTURE_API_KEY"], base_url=os.environ["FIXTURE_BASE_URL"]
    )
    await hub.gateway.chat(
        "stub-model",
        [{"role": "user", "content": "ping"}],
        provider={"base_url": os.environ["FIXTURE_PROVIDER_URL"], "api_key": "p"},
    )
    # No aclose(). The event loop closes below with spans still buffered.


asyncio.run(main())
print("done", end="")
