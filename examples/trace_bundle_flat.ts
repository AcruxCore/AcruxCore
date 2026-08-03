/**
 * Bundle 5 gateway calls into ONE trace using only x-trace-id (no span/parent
 * ids). They show up as one waterfall, positioned by real start/end time, but
 * flat — no parent/child indentation.
 *
 * T9 demo: trace name/tags/metadata and span name/tags/metadata can now be set
 * on ANY call sharing the trace, not just the one that creates it.
 *
 * - Trace name: last-explicit-write-wins. A call that supplies x-trace-name
 *   renames the trace; a call that omits it leaves the current name alone.
 *   Below: call 1 sets no name (trace starts on its timestamp fallback), call 2
 *   names it "trip-planner-draft", call 3 leaves it alone, call 4 renames it
 *   again to "trip-planner-final", call 5 leaves it alone — the trace ends up
 *   named "trip-planner-final".
 * - Trace tags/metadata: merge (union tags, shallow-merge metadata) across
 *   every call that supplies them — unchanged from T8.
 * - Span name/tags/metadata: per-call, since every call mints exactly one new
 *   span — no merge ambiguity. Calls 1-4 give their span a custom name; call 5
 *   gives none, so that span's name falls back to its own start timestamp.
 *
 * x-trace-id already works today; nothing new needed for this script's grouping.
 *
 * Needs: npm install openai
 * Run: npx tsx trace_bundle_flat.ts
 */
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

const BASE_URL = 'http://localhost:3001/api/v1';
const GATEWAY_KEY =
  process.env.ACRUXCORE_GATEWAY_KEY ?? 'agh_sk_REPLACE_WITH_YOUR_GATEWAY_KEY';

const client = new OpenAI({ apiKey: GATEWAY_KEY, baseURL: `${BASE_URL}/gateway` });

// One id, shared by all 5 calls — that's the whole mechanism.
const traceId = randomUUID();

interface CallOptions {
  traceName?: string;
  traceTags?: string[];
  traceMetadata?: Record<string, unknown>;
  spanName?: string;
  spanTags?: string[];
  spanMetadata?: Record<string, unknown>;
}

function call(model: string, content: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { 'x-trace-id': traceId };
  if (opts.traceName) headers['x-trace-name'] = opts.traceName;
  if (opts.traceTags) headers['x-trace-tags'] = opts.traceTags.join(',');
  if (opts.traceMetadata) headers['x-trace-metadata'] = JSON.stringify(opts.traceMetadata);
  if (opts.spanName) headers['x-span-name'] = opts.spanName;
  if (opts.spanTags) headers['x-span-tags'] = opts.spanTags.join(',');
  if (opts.spanMetadata) headers['x-span-metadata'] = JSON.stringify(opts.spanMetadata);

  return client.chat.completions.create({ model, messages: [{ role: 'user', content }] }, { headers });
}

async function main() {
  // Call 1 — no trace name yet, so the trace mints on its timestamp fallback.
  await call('GLM', "User asked: plan me a 3-day trip to Lisbon. What's the intent?", {
    traceTags: ['prod', 'travel-bot'],
    traceMetadata: { tripId: 'trip_452' },
    spanName: 'detect-intent',
  });

  // Call 2 — first call to actually name the trace.
  await call('GLM', "Extract travel dates from: 'sometime next month, for 3 days'.", {
    traceName: 'trip-planner-draft',
    spanName: 'extract-dates',
  });

  // Call 3 — no trace name: leaves "trip-planner-draft" alone. Adds trace
  // metadata (merges with tripId) and this call's own span tags/metadata.
  const r3 = await call('Mimo', 'Summarize these flight options: [...]', {
    traceMetadata: { userId: 'u_789' },
    spanName: 'summarize-flights',
    spanTags: ['flights'],
    spanMetadata: { segment: 'flights' },
  });

  // Call 4 — renames the trace again. Last explicit write still wins, even
  // over an already-explicit name.
  const r4 = await call('Mimo', 'Summarize these hotel options: [...]', {
    traceName: 'trip-planner-final',
    spanName: 'summarize-hotels',
  });

  // Call 5 — no trace name (stays "trip-planner-final") and no span name, so
  // this span's name falls back to its own start timestamp.
  const r5 = await call(
    'Mimo',
    `Compose a final itinerary from:\nFlights: ${r3.choices[0].message.content}\nHotels: ${r4.choices[0].message.content}`,
  );

  console.log('trace id:', traceId);
  console.log('final itinerary:\n', r5.choices[0].message.content);
}

main();
