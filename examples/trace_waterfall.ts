/**
 * Chain 5 gateway calls into one trace, nested as a waterfall, with a named
 * trace + tags + metadata (LangSmith-style).
 *
 * PREVIEW — this is the target API shape we're aligning on before implementing
 * it. Today the gateway only understands x-trace-id / x-parent-span-id /
 * x-session-id / x-capture-payloads. This script also uses x-span-id,
 * x-trace-name, x-trace-tags, and x-trace-metadata, which do not exist in the
 * API yet.
 *
 * Needs: npm install openai
 * Run: npx tsx trace_waterfall.ts
 */
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

const BASE_URL = 'http://localhost:3001/api/v1';
const GATEWAY_KEY =
  process.env.ACRUXCORE_GATEWAY_KEY ?? 'agh_sk_REPLACE_WITH_YOUR_GATEWAY_KEY';

const client = new OpenAI({ apiKey: GATEWAY_KEY, baseURL: `${BASE_URL}/gateway` });

// Every id is minted by US, up front — nothing is read back from a response.
const traceId = randomUUID();
const spanDetectIntent = randomUUID();
const spanExtractDates = randomUUID();
const spanFlights = randomUUID();
const spanHotels = randomUUID();
const spanCompose = randomUUID();

/** One gateway completion, wired into the shared trace via headers. */
function call(
  spanId: string,
  parentSpanId: string | null,
  model: string,
  content: string,
  mintTrace = false,
) {
  const headers: Record<string, string> = {
    'x-trace-id': traceId,
    'x-span-id': spanId,
  };
  if (parentSpanId) headers['x-parent-span-id'] = parentSpanId;
  if (mintTrace) {
    // Only honored by the call that actually creates the trace row.
    headers['x-trace-name'] = 'trip-planner-run';
    headers['x-trace-tags'] = 'prod,travel-bot';
    headers['x-trace-metadata'] = JSON.stringify({ userId: 'u_789', tripId: 'trip_452' });
  }

  return client.chat.completions.create({ model, messages: [{ role: 'user', content }] }, { headers });
}

async function main() {
  // 1. detect_intent — root span, mints the trace + its name/tags/metadata.
  await call(spanDetectIntent, null, 'gpt-4o-mini', "User asked: plan me a 3-day trip to Lisbon. What's the intent?", true);

  // 2. extract_travel_dates — child of call 1.
  await call(spanExtractDates, spanDetectIntent, 'gpt-4o-mini', "Extract travel dates from: 'sometime next month, for 3 days'.");

  // 3. search_flights_summary — child of call 1.
  const r3 = await call(spanFlights, spanDetectIntent, 'gpt-4o', 'Summarize these flight options: [...]');

  // 4. search_hotels_summary — child of call 1.
  const r4 = await call(spanHotels, spanDetectIntent, 'gpt-4o', 'Summarize these hotel options: [...]');

  // 5. compose_itinerary — child of call 1, runs after 3 and 4 finish.
  const r5 = await call(
    spanCompose,
    spanDetectIntent,
    'gpt-4o',
    `Compose a final itinerary from:\nFlights: ${r3.choices[0].message.content}\nHotels: ${r4.choices[0].message.content}`,
  );

  console.log('trace id:', traceId);
  console.log('final itinerary:\n', r5.choices[0].message.content);

  // Equivalent last call using plain `fetch` instead of the openai client —
  // same headers, same shared traceId/parent id.
  const raw = await fetch(`${BASE_URL}/gateway/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GATEWAY_KEY}`,
      'Content-Type': 'application/json',
      'x-trace-id': traceId,
      'x-span-id': randomUUID(),
      'x-parent-span-id': spanDetectIntent,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'One-line summary of the itinerary above.' }],
    }),
  });
  console.log('raw fetch call status:', raw.status);
  const rawJson = await raw.json();
  console.log(rawJson.choices[0].message.content);
}

main();
