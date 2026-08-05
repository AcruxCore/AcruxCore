"""
View trace analytics -- Python verification script.

Walks the View trace analytics guide's full read-chain in one pass, against a
real running Acrux Core API:

  1. Ingest one trace via a raw POST /traces call (httpx, not an SDK wrapper --
     there isn't one for arbitrary spans), carrying a session id, a tag, and a
     metadata key, so the later reads have real data without depending on
     pre-existing team state.
  2. hub.traces.analytics() -- print totals.requests.
  3. hub.traces.list_facets() -- print tags/metadata_keys.
  4. hub.traces.get_facet_values(key) -- print values for the metadata key
     ingested in step 1.
  5. hub.traces.get_settings() -- save the current capture_payloads value.
  6. hub.traces.update_settings(not current) -- print the new value.
  7. hub.traces.get_settings() again -- confirm it changed.
  8. hub.traces.update_settings(original) -- restore, so repeated runs don't
     drift team state.
  9. hub.traces.get_feedback_summary() and hub.traces.list_feedback() -- print
     both (may be empty on a fresh team).
  10. hub.sessions.list() -- print total.
  11. hub.sessions.get(session_id) -- print the trace count.
  12. A final hub.traces.get_settings() call that ASSERTS capture_payloads is
      back at its step-5 original value -- a broken restore fails the script's
      exit code, not just the printed log.

Requires:
  pip install acruxcore

Env vars:
  ACRUXCORE_API_KEY   -- personal API key (needed for update_settings to
                          succeed; a team-scoped key gets a 403).
  ACRUXCORE_BASE_URL   -- e.g. http://localhost:3001/api/v1
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone

import httpx
from acruxcore import AcruxCore

API_KEY = os.environ["ACRUXCORE_API_KEY"]
BASE_URL = os.environ.get("ACRUXCORE_BASE_URL", "http://localhost:3001/api/v1").rstrip("/")
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

RUN_ID = uuid.uuid4().hex[:8]
SESSION_ID = f"trace-analytics-check-{RUN_ID}"
TAG = "trace-analytics-check"
METADATA_KEY = "checkRunId"
METADATA_VALUE = RUN_ID


def section(number, title):
    print(f"\n{'=' * 64}\n{number}. {title}\n{'=' * 64}")


async def ingest_one_trace() -> str:
    """Raw POST /traces -- one llm span, tagged and stamped with a session id
    and a metadata key, so every later read step has real data to see."""
    now = datetime.now(timezone.utc)
    start = now.isoformat()
    end = now.isoformat()
    payload = {
        "traces": [
            {
                "name": "view-trace-analytics-check",
                "sessionId": SESSION_ID,
                "tags": [TAG],
                "metadata": {METADATA_KEY: METADATA_VALUE},
                "spans": [
                    {
                        "spanId": "s1",
                        "name": "gpt-4o-mini",
                        "kind": "llm",
                        "status": "ok",
                        "startTime": start,
                        "endTime": end,
                        "model": "gpt-4o-mini",
                        "provider": "openai",
                        "usage": {"promptTokens": 12, "completionTokens": 4, "totalTokens": 16},
                        "costUsd": 0.0000123,
                    }
                ],
            }
        ]
    }
    async with httpx.AsyncClient() as client:
        response = await client.post(f"{BASE_URL}/traces", headers=HEADERS, json=payload)
        response.raise_for_status()
        body = response.json()
    trace_id = body["traceIds"][0]
    print(f"accepted spans : {body['accepted']}")
    print(f"trace id       : {trace_id}")
    print(f"session id     : {SESSION_ID}")
    print(f"tag            : {TAG}")
    print(f"metadata       : {{{METADATA_KEY!r}: {METADATA_VALUE!r}}}")
    return trace_id


async def main():
    async with AcruxCore(api_key=API_KEY, base_url=BASE_URL) as hub:
        section(1, "Ingest one trace (raw POST /traces)")
        await ingest_one_trace()

        section(2, "hub.traces.analytics()")
        analytics = await hub.traces.analytics()
        print(f"totals.requests : {analytics.totals.requests}")

        section(3, "hub.traces.list_facets()")
        facets = await hub.traces.list_facets()
        print(f"tags          : {facets.tags}")
        print(f"metadata keys : {facets.metadata_keys}")

        section(4, f"hub.traces.get_facet_values({METADATA_KEY!r})")
        facet_values = await hub.traces.get_facet_values(METADATA_KEY)
        print(f"values : {facet_values.values}")

        section(5, "hub.traces.get_settings() -- save original")
        original_settings = await hub.traces.get_settings()
        original_capture_payloads = original_settings.capture_payloads
        print(f"capture_payloads (original) : {original_capture_payloads}")

        section(6, "hub.traces.update_settings(not original)")
        toggled_settings = await hub.traces.update_settings(not original_capture_payloads)
        print(f"capture_payloads (toggled)  : {toggled_settings.capture_payloads}")

        section(7, "hub.traces.get_settings() -- confirm it changed")
        confirmed_settings = await hub.traces.get_settings()
        print(f"capture_payloads (confirmed): {confirmed_settings.capture_payloads}")
        if confirmed_settings.capture_payloads != (not original_capture_payloads):
            raise RuntimeError(
                "settings did not toggle as expected: "
                f"expected {not original_capture_payloads}, got {confirmed_settings.capture_payloads}"
            )

        section(8, "hub.traces.update_settings(original) -- restore")
        restored_settings = await hub.traces.update_settings(original_capture_payloads)
        print(f"capture_payloads (restored) : {restored_settings.capture_payloads}")

        section(9, "hub.traces.get_feedback_summary() / list_feedback()")
        feedback_summary = await hub.traces.get_feedback_summary()
        print(f"feedback summary buckets : {len(feedback_summary.buckets)} (group_by={feedback_summary.group_by})")
        feedback_list = await hub.traces.list_feedback()
        print(f"feedback list total      : {feedback_list.total}")

        section(10, "hub.sessions.list()")
        sessions = await hub.sessions.list()
        print(f"sessions total : {sessions.total}")

        section(11, f"hub.sessions.get({SESSION_ID!r})")
        session_detail = await hub.sessions.get(SESSION_ID)
        print(f"session trace count : {session_detail.session.trace_count}")

        section(12, "hub.traces.get_settings() -- final restore check (asserted)")
        final_settings = await hub.traces.get_settings()
        print(f"capture_payloads (final) : {final_settings.capture_payloads}")
        if final_settings.capture_payloads != original_capture_payloads:
            raise RuntimeError(
                "RESTORE FAILED: capture_payloads is "
                f"{final_settings.capture_payloads}, expected original {original_capture_payloads}"
            )
        print("restore verified: capture_payloads matches its original value.")

    print("\nAll steps completed successfully.")


if __name__ == "__main__":
    asyncio.run(main())
