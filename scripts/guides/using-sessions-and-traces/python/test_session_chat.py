"""
Session grouping test -- Python SDK.

Tests whether chat() (no tools) groups traces under a session, and whether
run_tool_loop() does the same. Makes four calls with the same session id,
then reads each trace back to check whether session_id landed on the trace.

Three scenarios tested:
  1. chat() with trace.session_id  (no tools)
  2. chat() with trace.session_id  (no tools, second call)
  3. run_tool_loop() with trace.session_id (with a tool)

Then queries the session via list_traces(session_id=...) to see which calls
actually rolled up.

Requires:
  pip install acruxcore requests
"""
import asyncio
import os
import uuid

import requests
from acruxcore import AcruxCore

API_KEY = os.environ["ACRUXCORE_API_KEY"]
BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "http://localhost:3001/api/v1").rstrip("/")
MODEL = os.environ.get("ACRUXCORE_MODEL", "mimo-v2.5")
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

SESSION_ID = f"session-chat-test-{uuid.uuid4().hex[:8]}"


def section(number, title):
    print(f"\n{'=' * 64}\n{number}. {title}\n{'=' * 64}")


async def get_current_time(name, args):
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


async def main():
    async with AcruxCore() as hub:
        # --- Call 1: chat() no tools, with session_id ----------------------
        section(1, "chat() call 1 -- no tools")
        r1 = await hub.chat(
            MODEL,
            [{"role": "user", "content": "Say hello in one word."}],
            trace={"tags": ["session-test"], "session_id": SESSION_ID},
        )
        trace1_id = r1.gateway.trace_id
        print(f"trace id : {trace1_id}")
        print(f"reply    : {r1.content}")

        # --- Call 2: chat() no tools, same session_id ----------------------
        section(2, "chat() call 2 -- no tools")
        r2 = await hub.chat(
            MODEL,
            [{"role": "user", "content": "Say goodbye in one word."}],
            trace={"tags": ["session-test"], "session_id": SESSION_ID},
        )
        trace2_id = r2.gateway.trace_id
        print(f"trace id : {trace2_id}")
        print(f"reply    : {r2.content}")

        # --- Call 3: run_tool_loop(), same session_id ----------------------
        section(3, "run_tool_loop() -- with tool")
        result = await hub.run_tool_loop(
            MODEL,
            [{"role": "user", "content": "What time is it? Use the tool."}],
            tool_defs=[
                {
                    "type": "function",
                    "function": {
                        "name": "get_current_time",
                        "description": "Returns the current UTC time.",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
            dispatch=get_current_time,
            sync=False,
            trace={"tags": ["session-test"], "session_id": SESSION_ID},
        )
        trace3_id = result.trace_id
        assert trace3_id is not None
        print(f"trace id : {trace3_id}")
        print(f"reply    : {result.content.strip()}")

        # --- Read all three traces back ------------------------------------
        section(4, "Read traces back -- check session_id")
        for label, tid in [("chat call 1", trace1_id), ("chat call 2", trace2_id), ("run_tool_loop", trace3_id)]:
            detail = await hub.get_trace(tid)
            sid = detail.trace.session_id
            print(f"  {label:20s}  trace={tid}  session_id={sid}")

        # --- Query the session via list_traces -----------------------------
        section(5, f"list_traces(session_id={SESSION_ID})")
        session_traces = await hub.list_traces(session_id=SESSION_ID)
        print(f"traces in session: {len(session_traces.data)}")
        for t in session_traces.data:
            print(f"  {t.id}")

        # --- Also try the REST endpoint directly ---------------------------
        section(6, "REST: GET /traces?session_id=...")
        r = requests.get(
            f"{BASE_URL}/traces",
            params={"session_id": SESSION_ID},
            headers=HEADERS,
        )
        r.raise_for_status()
        body = r.json()
        print(f"REST traces in session: {body['total']}")
        for t in body["data"]:
            print(f"  {t['id']}  session_id={t.get('session_id')}")


if __name__ == "__main__":
    asyncio.run(main())
