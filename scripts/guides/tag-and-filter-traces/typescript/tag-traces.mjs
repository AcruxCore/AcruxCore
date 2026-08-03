/**
 * Tag and filter traces -- Node.
 *
 * Walks the Tag & filter traces guide (apps/docs/docs/guides/tag-and-filter-traces.mdx):
 *
 *   1. Attach tags + metadata to a trace via chat().
 *   2. Attach tags + metadata to a second trace via runToolLoop() (inline
 *      toolDefs, no catalog writes).
 *   3. Read the trace back with getTrace() to confirm the tags landed.
 *   4. Filter traces by tag and by metadata over REST -- the SDK's listTraces()
 *      has no tag/metadata filters yet.
 *   5. List tag and metadata facets over REST.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk
 */
import AcruxCore from '@acruxcoreai/sdk';
import { randomUUID } from 'node:crypto';

const API_KEY = process.env.ACRUXCORE_API_KEY;
const BASE_URL = (process.env.ACRUXCORE_BASE_URL || 'http://localhost:3001/api/v1').replace(/\/+$/, '');
const MODEL = process.env.ACRUXCORE_MODEL || 'mimo-v2.5';
const HEADERS = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

const TAGS = ['prod', 'tag-filter-demo'];
const METADATA = { env: 'prod', requestId: randomUUID() };
// One shared session id so both calls roll up under a single session in the
// dashboard (Observability -> Sessions). A session is just a sessionId string
// stamped on one or more traces -- it springs into existence on first use.
const SESSION_ID = `tag-filter-demo-${randomUUID().slice(0, 8)}`;

function section(number, title) {
  console.log(`\n${'='.repeat(64)}\n${number}. ${title}\n${'='.repeat(64)}`);
}

async function main() {
  const hub = new AcruxCore();

  // 1. chat() with trace tags + metadata ------------------------------------
  section(1, 'Trace tags via chat()');
  const chat = await hub.chat({
    model: MODEL,
    messages: [{ role: 'user', content: 'Say hi in one word.' }],
    trace: { tags: TAGS, metadata: METADATA, sessionId: SESSION_ID },
  });
  const chatTraceId = chat.gateway.traceId;
  console.log('reply        :', chat.content);
  console.log('trace id     :', chatTraceId);
  console.log('tags         :', TAGS);
  console.log('metadata     :', METADATA);
  console.log('session id   :', SESSION_ID);

  // 2. runToolLoop() -- tags land on the trace ------------------------------
  section(2, 'Trace tags via runToolLoop()');
  const result = await hub.runToolLoop({
    model: MODEL,
    messages: [{ role: 'user', content: 'What time is it? Use the tool to check.' }],
    toolDefs: [
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description: 'Returns the current UTC time.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    dispatch: async () => new Date().toISOString(),
    sync: false,
    trace: { tags: TAGS, metadata: METADATA, sessionId: SESSION_ID },
  });
  const loopTraceId = result.traceId;
  console.log('answer       :', result.content.trim());
  console.log('trace id     :', loopTraceId);
  console.log('model turns  :', result.iterations);

  // 3. read the trace back to prove the tags persisted ----------------------
  section(3, 'Read the trace back (getTrace)');
  const detail = await hub.getTrace(loopTraceId);
  console.log('trace session  :', detail.trace.sessionId);
  console.log('trace tags     :', detail.trace.tags);
  console.log('trace metadata :', detail.trace.metadata);

  // 4. filter traces by tag / by metadata (REST) ---------------------------
  section(4, 'Filter traces by tag and metadata (REST)');
  // by tag -- repeated `tags=` params are AND-ed
  const tagParams = new URLSearchParams(TAGS.map((t) => ['tags', t]));
  let res = await fetch(`${BASE_URL}/traces?${tagParams}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`filter tags ${res.status}: ${await res.text()}`);
  let body = await res.json();
  console.log(`?tags=${JSON.stringify(TAGS)}  -> ${body.total} match(es)`);
  for (const t of body.data) console.log(`  ${t.id}  tags=${JSON.stringify(t.tags)}`);
  // by metadata -- bracket params `metadata[key]=value` are AND-ed
  const metaParams = new URLSearchParams(
    Object.entries(METADATA).map(([k, v]) => [`metadata[${k}]`, String(v)])
  );
  res = await fetch(`${BASE_URL}/traces?${metaParams}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`filter metadata ${res.status}: ${await res.text()}`);
  body = await res.json();
  console.log(`?metadata=${JSON.stringify(METADATA)}  -> ${body.total} match(es)`);

  // 5. list tag and metadata facets (REST) ----------------------------------
  section(5, 'List tag and metadata facets (REST)');
  res = await fetch(`${BASE_URL}/traces/facets`, { headers: HEADERS });
  if (!res.ok) throw new Error(`facets ${res.status}: ${await res.text()}`);
  console.log('facets:', await res.json());
  res = await fetch(`${BASE_URL}/traces/facets/values?key=env`, { headers: HEADERS });
  if (!res.ok) throw new Error(`facet values ${res.status}: ${await res.text()}`);
  console.log('env values:', await res.json());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
