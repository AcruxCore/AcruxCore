"""
Tag and filter traces -- Python.

Walks the Tag & filter traces guide (apps/docs/docs/guides/tag-and-filter-traces.mdx):

  1. Attach tags + metadata to a trace via chat().
  2. Attach tags + metadata to a second trace via run_tool_loop() (inline
     tool_defs, no catalog writes).
  3. Read the trace back with get_trace() to confirm the tags landed.
  4. Filter traces by tag and by metadata over REST -- the SDK's list_traces()
     has no tag/metadata filters yet.
  5. List tag and metadata facets over REST.

Requires:
  pip install acruxcore requests
"""
import asyncio
import json
import os
import uuid
from datetime import datetime, timezone

import requests
from acruxcore import AcruxCore
from acruxcore.types import ChatResult

API_KEY = os.environ["ACRUXCORE_API_KEY"]
BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "http://localhost:3001/api/v1").rstrip("/")
MODEL = os.environ.get("ACRUXCORE_MODEL", "mimo-v2.5")
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

TAGS = ["prod", "tag-filter-demo"]
METADATA = {"env": "prod", "requestId": str(uuid.uuid4())}
# One shared session id so both calls roll up under a single session in the
# dashboard (Observability -> Sessions). A session is just a sessionId string
# stamped on one or more traces -- it springs into existence on first use.
SESSION_ID = f"tag-filter-demo-{uuid.uuid4().hex[:8]}"


def section(number, title):
    print(f"\n{'=' * 64}\n{number}. {title}\n{'=' * 64}")


async def get_current_time(name, args):
    return datetime.now(timezone.utc).isoformat()


async def main():
    async with AcruxCore() as hub:
        # 1. chat() with trace tags + metadata --------------------------------
        section(1, "Trace tags via chat()")
        chat = await hub.chat(
            MODEL,
            [{"role": "user", "content": "Say hi in one word."}],
            trace={"tags": TAGS, "metadata": METADATA, "session_id": SESSION_ID},
        )
        assert isinstance(chat, ChatResult)
        chat_trace_id = chat.gateway.trace_id
        print(f"reply        : {chat.content}")
        print(f"trace id     : {chat_trace_id}")
        print(f"tags         : {TAGS}")
        print(f"metadata     : {METADATA}")
        print(f"session id   : {SESSION_ID}")

        # 2. run_tool_loop() -- tags land on the trace -----------------------
        section(2, "Trace tags via run_tool_loop()")
        result = await hub.run_tool_loop(
            MODEL,
            [{"role": "user", "content": "What time is it? Use the tool to check."}],
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
            trace={"tags": TAGS, "metadata": METADATA, "session_id": SESSION_ID},
        )
        loop_trace_id = result.trace_id
        assert loop_trace_id is not None
        print(f"answer       : {result.content.strip()}")
        print(f"trace id     : {loop_trace_id}")
        print(f"model turns  : {result.iterations}")

        # 3. read the trace back to prove the tags persisted ------------------
        section(3, "Read the trace back (get_trace)")
        detail = await hub.get_trace(loop_trace_id)
        print(f"trace session  : {detail.trace.session_id}")
        print(f"trace tags     : {detail.trace.raw.get('tags')}")
        print(f"trace metadata : {detail.trace.raw.get('metadata')}")

        # 4. filter traces by tag / by metadata (REST) ------------------------
        section(4, "Filter traces by tag and metadata (REST)")
        # by tag -- repeated `tags=` params are AND-ed
        r = requests.get(
            f"{BASE_URL}/traces",
            params=[("tags", t) for t in TAGS],
            headers=HEADERS,
        )
        r.raise_for_status()
        body = r.json()
        print(f"?tags={TAGS}  -> {body['total']} match(es)")
        for t in body["data"]:
            print(f"  {t['id']}  tags={t.get('tags')}")
        # by metadata -- bracket params `metadata[key]=value` are AND-ed
        r = requests.get(
            f"{BASE_URL}/traces",
            params=[(f"metadata[{k}]", str(v)) for k, v in METADATA.items()],
            headers=HEADERS,
        )
        r.raise_for_status()
        body = r.json()
        print(f"?metadata={METADATA}  -> {body['total']} match(es)")

        # 5. list tag and metadata facets (REST) ------------------------------
        section(5, "List tag and metadata facets (REST)")
        r = requests.get(f"{BASE_URL}/traces/facets", headers=HEADERS)
        r.raise_for_status()
        print(f"facets: {json.dumps(r.json())}")
        r = requests.get(
            f"{BASE_URL}/traces/facets/values",
            params={"key": "env"},
            headers=HEADERS,
        )
        r.raise_for_status()
        print(f"env values: {json.dumps(r.json())}")


if __name__ == "__main__":
    asyncio.run(main())
