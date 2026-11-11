/**
 * Find the slow step in your app -- Node.
 *
 * Runs the small support app from the "Find the slow step in your app" guide
 * (apps/docs/docs/guides/traces/find-the-slow-step-in-your-app.mdx):
 *
 *   answer-question   agent      one trace per question
 *   ├─ retrieve-docs  retrieval  searches ../data/help-articles.json
 *   ├─ lookup-order   tool       reads ../data/orders.json; fails for an unknown order
 *   └─ support-model  llm        the gateway call that writes the answer
 *
 * Then it reads the same numbers the dashboard's "By step (span name)" table
 * shows, slowest p95 first.
 *
 * retrieve-docs sleeps 1.5-2.5 s to stand in for a slow vector-store query, so
 * it is the step the table points at.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk
 *
 * Env:
 *   ACRUXCORE_API_KEY   -- required
 *   ACRUXCORE_BASE_URL  -- defaults to https://api.acruxcore.com/api/v1 in the SDK
 *   ACRUXCORE_MODEL     -- a model registered under Gateway -> Models
 *                          (default: support-model)
 *
 * Run:
 *   node find-slow-step.mjs
 */
import AcruxCore from '@acruxcoreai/sdk';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const data = (file) => JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'));
const ARTICLES = data('help-articles.json');
const ORDERS = data('orders.json');
const QUESTIONS = data('questions.json');
const MODEL = process.env.ACRUXCORE_MODEL ?? 'support-model';
const between = (lo, hi) => lo + Math.random() * (hi - lo);

const hub = new AcruxCore();

const retrieveDocs = hub.traces.wrap('retrieve-docs', { kind: 'retrieval' }, async (question) => {
  await sleep(between(1500, 2500)); // stands in for a slow vector store
  const words = new Set(question.toLowerCase().replace('?', '').split(' '));
  const score = (a) => a.body.toLowerCase().split(' ').filter((w) => words.has(w)).length;
  return ARTICLES.map((a) => [score(a), a])
    .sort((x, y) => y[0] - x[0])
    .slice(0, 2)
    .filter(([s]) => s > 0)
    .map(([, a]) => a);
});

const lookupOrder = hub.traces.wrap('lookup-order', { kind: 'tool' }, async (orderId) => {
  await sleep(between(20, 60));
  if (!(orderId in ORDERS)) throw new Error(`no order ${orderId}`);
  return ORDERS[orderId];
});

const answerQuestion = hub.traces.wrap('answer-question', { kind: 'agent' }, async (question, orderId) => {
  const articles = await retrieveDocs(question);
  // The span is still marked as an error when the lookup fails.
  const order = await lookupOrder(orderId).catch(() => null);
  const context = articles.map((a) => `- ${a.title}: ${a.body}`).join('\n');
  const reply = await hub.gateway.chat({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Answer in one sentence, using only the help articles and order.' },
      {
        role: 'user',
        content: `Help articles:\n${context}\n\nOrder: ${JSON.stringify(order)}\n\nQuestion: ${question}`,
      },
    ],
  });
  return reply.content;
});

for (const q of QUESTIONS) {
  const answer = await answerQuestion(q.question, q.order_id);
  console.log(`${q.order_id}  ${q.question}\n          ${answer}`);
}

// Each trace is sent when its outermost step ends, in the background.
await hub.traces.flush();

const result = await hub.traces.analytics({ groupBy: 'span_name' });
console.log(`\n${'step'.padEnd(18)}${'calls'.padStart(6)}${'failed'.padStart(8)}${'p50 ms'.padStart(8)}${'p95 ms'.padStart(8)}`);
for (const b of [...result.buckets].sort((x, y) => y.latencyMs.p95 - x.latencyMs.p95)) {
  console.log(
    `${b.key.padEnd(18)}${String(b.requests).padStart(6)}${String(Math.round(b.errorRate * b.requests)).padStart(8)}` +
      `${String(Math.round(b.latencyMs.p50)).padStart(8)}${String(Math.round(b.latencyMs.p95)).padStart(8)}`,
  );
}

await hub.gateway.close();
