/**
 * View trace analytics -- Node verification script.
 *
 * Walks the View trace analytics guide's full read-chain in one pass, against
 * a real running AcruxCore API:
 *
 *   1. Ingest one trace via a raw POST /traces call (fetch, not an SDK wrapper
 *      -- there isn't one for arbitrary spans), carrying a session id, a tag,
 *      and a metadata key, so the later reads have real data without
 *      depending on pre-existing team state.
 *   2. hub.traces.analytics() -- print totals.requests.
 *   3. hub.traces.listFacets() -- print tags/metadataKeys.
 *   4. hub.traces.getFacetValues(key) -- print values for the metadata key
 *      ingested in step 1.
 *   5. hub.traces.getSettings() -- save the current capturePayloads value.
 *   6. hub.traces.updateSettings(!current) -- print the new value.
 *   7. hub.traces.getSettings() again -- confirm it changed.
 *   8. hub.traces.updateSettings(original) -- restore, so repeated runs don't
 *      drift team state.
 *   9. hub.traces.getFeedbackSummary() and hub.traces.listFeedback() -- print
 *      both (may be empty on a fresh team).
 *   10. hub.sessions.list() -- print total.
 *   11. hub.sessions.get(sessionId) -- print the trace count.
 *   12. A final hub.traces.getSettings() call that ASSERTS capturePayloads is
 *       back at its step-5 original value -- a broken restore fails the
 *       script's exit code, not just the printed log.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk
 *
 * Env vars:
 *   ACRUXCORE_API_KEY   -- personal API key (needed for updateSettings to
 *                           succeed; a team-scoped key gets a 403).
 *   ACRUXCORE_BASE_URL  -- e.g. http://localhost:3001/api/v1
 */
import AcruxCore from '@acruxcoreai/sdk';
import { randomUUID } from 'node:crypto';

const API_KEY = process.env.ACRUXCORE_API_KEY;
const BASE_URL = (process.env.ACRUXCORE_BASE_URL || 'http://localhost:3001/api/v1').replace(/\/+$/, '');
const HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

const RUN_ID = randomUUID().slice(0, 8);
const SESSION_ID = `trace-analytics-check-${RUN_ID}`;
const TAG = 'trace-analytics-check';
const METADATA_KEY = 'checkRunId';
const METADATA_VALUE = RUN_ID;

function section(number, title) {
  console.log(`\n${'='.repeat(64)}\n${number}. ${title}\n${'='.repeat(64)}`);
}

/** Raw POST /traces -- one llm span, tagged and stamped with a session id and
 * a metadata key, so every later read step has real data to see. */
async function ingestOneTrace() {
  const now = new Date().toISOString();
  const payload = {
    traces: [
      {
        name: 'view-trace-analytics-check',
        sessionId: SESSION_ID,
        tags: [TAG],
        metadata: { [METADATA_KEY]: METADATA_VALUE },
        spans: [
          {
            spanId: 's1',
            name: 'gpt-4o-mini',
            kind: 'llm',
            status: 'ok',
            startTime: now,
            endTime: now,
            model: 'gpt-4o-mini',
            provider: 'openai',
            usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
            costUsd: 0.0000123,
          },
        ],
      },
    ],
  };
  const res = await fetch(`${BASE_URL}/traces`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ingest trace ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const traceId = body.traceIds[0];
  console.log('accepted spans :', body.accepted);
  console.log('trace id       :', traceId);
  console.log('session id     :', SESSION_ID);
  console.log('tag            :', TAG);
  console.log('metadata       :', { [METADATA_KEY]: METADATA_VALUE });
  return traceId;
}

async function main() {
  const hub = new AcruxCore({ apiKey: API_KEY, baseUrl: BASE_URL });

  section(1, 'Ingest one trace (raw POST /traces)');
  await ingestOneTrace();

  section(2, 'hub.traces.analytics()');
  const analytics = await hub.traces.analytics();
  console.log('totals.requests :', analytics.totals.requests);

  section(3, 'hub.traces.listFacets()');
  const facets = await hub.traces.listFacets();
  console.log('tags          :', facets.tags);
  console.log('metadata keys :', facets.metadataKeys);

  section(4, `hub.traces.getFacetValues(${JSON.stringify(METADATA_KEY)})`);
  const facetValues = await hub.traces.getFacetValues(METADATA_KEY);
  console.log('values :', facetValues.values);

  section(5, 'hub.traces.getSettings() -- save original');
  const originalSettings = await hub.traces.getSettings();
  const originalCapturePayloads = originalSettings.capturePayloads;
  console.log('capturePayloads (original) :', originalCapturePayloads);

  section(6, 'hub.traces.updateSettings(!original)');
  const toggledSettings = await hub.traces.updateSettings(!originalCapturePayloads);
  console.log('capturePayloads (toggled)  :', toggledSettings.capturePayloads);

  section(7, 'hub.traces.getSettings() -- confirm it changed');
  const confirmedSettings = await hub.traces.getSettings();
  console.log('capturePayloads (confirmed):', confirmedSettings.capturePayloads);
  if (confirmedSettings.capturePayloads !== !originalCapturePayloads) {
    throw new Error(
      `settings did not toggle as expected: expected ${!originalCapturePayloads}, got ${confirmedSettings.capturePayloads}`,
    );
  }

  section(8, 'hub.traces.updateSettings(original) -- restore');
  const restoredSettings = await hub.traces.updateSettings(originalCapturePayloads);
  console.log('capturePayloads (restored) :', restoredSettings.capturePayloads);

  section(9, 'hub.traces.getFeedbackSummary() / listFeedback()');
  const feedbackSummary = await hub.traces.getFeedbackSummary();
  console.log(`feedback summary buckets : ${feedbackSummary.buckets.length} (groupBy=${feedbackSummary.groupBy})`);
  const feedbackList = await hub.traces.listFeedback();
  console.log('feedback list total      :', feedbackList.total);

  section(10, 'hub.sessions.list()');
  const sessions = await hub.sessions.list();
  console.log('sessions total :', sessions.total);

  section(11, `hub.sessions.get(${JSON.stringify(SESSION_ID)})`);
  const sessionDetail = await hub.sessions.get(SESSION_ID);
  console.log('session trace count :', sessionDetail.session.traceCount);

  section(12, 'hub.traces.getSettings() -- final restore check (asserted)');
  const finalSettings = await hub.traces.getSettings();
  console.log('capturePayloads (final) :', finalSettings.capturePayloads);
  if (finalSettings.capturePayloads !== originalCapturePayloads) {
    throw new Error(
      `RESTORE FAILED: capturePayloads is ${finalSettings.capturePayloads}, expected original ${originalCapturePayloads}`,
    );
  }
  console.log('restore verified: capturePayloads matches its original value.');

  console.log('\nAll steps completed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
