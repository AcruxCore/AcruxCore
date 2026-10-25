/**
 * Turns a results.json written by gateway-latency-bench.mjs into the numbers the
 * post quotes: per-round paired gaps with 95% bootstrap confidence intervals,
 * and the median / p95 / p99 tail table.
 *
 * Gaps are paired per round (path A's round i minus path B's round i), which
 * cancels any network blip both paths shared that round. Pairing needs every
 * path to have the same number of samples, so a run with failures is refused.
 *
 * Usage: node summarize.mjs [results.json]
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'results.json';
const { samples, table } = JSON.parse(readFileSync(file, 'utf8'));

const RESAMPLES = 10_000;

/** Small seeded PRNG (mulberry32) so the confidence intervals are reproducible. */
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pairedGap(a, b) {
  if (samples[a].length !== samples[b].length) {
    throw new Error(`${a} and ${b} have different sample counts; rounds cannot be paired`);
  }
  const diffs = samples[a].map((x, i) => x - samples[b][i]);
  const rand = rng(42);
  const meds = [];
  for (let r = 0; r < RESAMPLES; r++) {
    const pick = diffs.map(() => diffs[Math.floor(rand() * diffs.length)]);
    meds.push(median(pick));
  }
  meds.sort((x, y) => x - y);
  return {
    median: median(diffs),
    lo: meds[Math.floor(0.025 * RESAMPLES)],
    hi: meds[Math.ceil(0.975 * RESAMPLES) - 1],
  };
}

const fmt = (ms) => `${ms >= 0 ? '+' : '−'}${Math.abs(ms).toFixed(1)} ms`;

console.log('| comparison | median gap | 95% confidence interval |');
console.log('|---|--:|---|');
for (const [a, b, label] of [
  ['gateway_local', 'openai_direct', 'Local gateway − OpenAI direct'],
  ['gateway_hosted', 'openai_direct', 'Hosted gateway − OpenAI direct'],
  ['byo_sdk_notrace', 'openai_direct', 'BYO (no trace) − OpenAI direct'],
  ['byo_sdk', 'byo_sdk_notrace', 'BYO (tracing on) − BYO (no trace)'],
]) {
  const g = pairedGap(a, b);
  console.log(`| ${label} | ${fmt(g.median)} | ${fmt(g.lo)} to ${fmt(g.hi)} |`);
}

console.log('\n| Path | median | p95 | p99 |');
console.log('|---|--:|--:|--:|');
for (const row of [...table].sort((x, y) => x.median - y.median)) {
  console.log(`| ${row.label} | ${row.median} ms | ${row.p95} ms | ${row.p99} ms |`);
}
