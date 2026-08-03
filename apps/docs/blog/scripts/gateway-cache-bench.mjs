/**
 * Exact-match cache benchmark backing "Exact-Match Gateway Caching: How Much
 * Latency and Spend It Actually Saves" (../2026-08-01-exact-match-gateway-caching.md).
 *
 * Sends the same fixed set of prompts through the gateway repeatedly, using a
 * virtual key with cacheTtlSeconds set. The first pass through each prompt is
 * a cache miss (real provider call); every later pass is a cache hit. Reads
 * the real x-gateway-cache and x-gateway-cost-usd response headers rather
 * than guessing hit/miss from latency alone.
 *
 * Env vars: ACRUXCORE_BASE_URL (default http://localhost:3001/api/v1),
 * ACX_CACHE_BENCH_KEY (a virtual key created with cacheTtlSeconds > 0).
 *
 * Usage: node gateway-cache-bench.mjs [passes]
 */

import { writeFileSync } from 'node:fs';

const BASE = process.env.ACRUXCORE_BASE_URL ?? 'http://localhost:3001/api/v1';
const KEY = process.env.ACX_CACHE_BENCH_KEY;
const PASSES = Number(process.argv[2] ?? 4);

if (!KEY) {
  console.error('Set ACX_CACHE_BENCH_KEY to a virtual key with cacheTtlSeconds > 0');
  process.exit(1);
}

// 15 distinct prompts — fixed content so every repeat is a byte-identical request.
const PROMPTS = Array.from({ length: 15 }, (_, i) => `Reply with the single word: ${
  ['pong', 'apple', 'ocean', 'ember', 'granite', 'willow', 'comet', 'lantern', 'harbor', 'thistle',
    'quartz', 'meadow', 'falcon', 'cinder', 'marble'][i]
}.`);

async function call(content) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/gateway/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content }],
      max_tokens: 5,
      temperature: 0, // required — an omitted temperature is never cached
    }),
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 160)}`);
  await res.json();
  return {
    ms,
    cache: res.headers.get('x-gateway-cache'),
    costUsd: Number(res.headers.get('x-gateway-cost-usd') || 0),
  };
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

async function main() {
  console.log(`passes=${PASSES} prompts=${PROMPTS.length} total_calls=${PASSES * PROMPTS.length}\n`);

  const misses = [];
  const hits = [];
  let missCostTotal = 0;
  let hitCostTotal = 0;

  for (let pass = 0; pass < PASSES; pass++) {
    for (const prompt of PROMPTS) {
      const r = await call(prompt);
      if (r.cache === 'hit') {
        hits.push(r.ms);
        hitCostTotal += r.costUsd;
      } else {
        misses.push(r.ms);
        missCostTotal += r.costUsd;
      }
    }
    console.log(`pass ${pass + 1}/${PASSES} done — misses=${misses.length} hits=${hits.length}`);
  }

  const missSorted = [...misses].sort((a, b) => a - b);
  const hitSorted = [...hits].sort((a, b) => a - b);

  const avgMissCost = missCostTotal / misses.length;
  // What every hit would have cost had caching been off, at the measured miss price.
  const costAvoided = avgMissCost * hits.length;

  const summary = {
    passes: PASSES,
    uniquePrompts: PROMPTS.length,
    misses: { n: misses.length, medianMs: Math.round(pct(missSorted, 50)), p95Ms: Math.round(pct(missSorted, 95)) },
    hits: { n: hits.length, medianMs: Math.round(pct(hitSorted, 50)), p95Ms: Math.round(pct(hitSorted, 95)) },
    cost: {
      missCostTotalUsd: Number(missCostTotal.toFixed(6)),
      hitCostTotalUsd: Number(hitCostTotal.toFixed(6)),
      avgMissCostUsd: Number(avgMissCost.toFixed(6)),
      costAvoidedUsd: Number(costAvoided.toFixed(6)),
    },
  };

  console.log('\n=== results ===');
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync('cache-results.json', JSON.stringify({ misses, hits, summary }, null, 2));
  console.log('\nwrote cache-results.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
