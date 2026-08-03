/**
 * Interleaved latency benchmark backing "How much overhead does an LLM gateway
 * add?" (../2026-07-13-llm-gateway-overhead.md).
 *
 * Every path ends at the same upstream (OpenAI gpt-4o-mini, same API key, same
 * prompt and parameters), so the model's own think time is a shared constant and
 * whatever is left over is the path.
 *
 * Paths:
 *   openai_direct    raw HTTPS POST to api.openai.com                  (baseline)
 *   byo_sdk_notrace  SDK chat({provider, trace:false}) -> OpenAI       (SDK cost)
 *   byo_sdk          SDK chat({provider})  -> OpenAI, tracing on       (BYO real)
 *   gateway_local    raw POST to a local production-build Acrux Core   (software)
 *   gateway_hosted   raw POST to api.acruxcore.com                    (real world)
 *
 * Env vars: OPENAI_API_KEY, ACX_HOSTED_KEY, ACX_LOCAL_KEY, and optionally
 * ACX_LOCAL_BASE_URL (defaults to http://localhost:3000/api/v1). Both the
 * hosted and local teams need a `gpt-4o-mini-bench` gateway model bound to
 * an OpenAI connection using the same key as OPENAI_API_KEY.
 *
 * Usage: node gateway-latency-bench.mjs [rounds] [warmup]
 */

import { writeFileSync } from 'node:fs';
import { acruxcore } from '@acruxcoreai/sdk';

const ROUNDS = Number(process.argv[2] ?? 60);
const WARMUP = Number(process.argv[3] ?? 3);

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const HOSTED_BASE = 'https://api.acruxcore.com/api/v1';
const LOCAL_BASE = process.env.ACX_LOCAL_BASE_URL ?? 'http://localhost:3000/api/v1';
const HOSTED_KEY = process.env.ACX_HOSTED_KEY;
const LOCAL_KEY = process.env.ACX_LOCAL_KEY;

/** The one request body every path sends, byte for byte. */
const MESSAGES = [{ role: 'user', content: 'Reply with the single word: pong.' }];
const BODY = { messages: MESSAGES, max_tokens: 5, temperature: 0 };

// One SDK client per BYO variant so neither pays for the other's state.
const PROVIDER = { baseUrl: 'https://api.openai.com/v1', apiKey: OPENAI_KEY };
const sdk = new acruxcore({ apiKey: HOSTED_KEY, baseUrl: HOSTED_BASE });

async function openaiDirect() {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', ...BODY }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 160)}`);
  await res.json();
}

async function byoSdkNoTrace() {
  await sdk.chat({
    model: 'gpt-4o-mini',
    messages: MESSAGES,
    maxTokens: 5,
    temperature: 0,
    provider: PROVIDER,
    trace: false,
  });
}

async function byoSdk() {
  await sdk.chat({
    model: 'gpt-4o-mini',
    messages: MESSAGES,
    maxTokens: 5,
    temperature: 0,
    provider: PROVIDER,
    // trace defaults to true on the BYO path — once the background-queue fix
    // ships, the report is queued and no longer blocks the response.
  });
}

async function gateway(base, apiKey) {
  const res = await fetch(`${base}/gateway/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-bench', ...BODY }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 160)}`);
  await res.json();
}

const PATHS = [
  { key: 'openai_direct', label: 'OpenAI direct', run: openaiDirect },
  { key: 'byo_sdk_notrace', label: 'BYO, no trace', run: byoSdkNoTrace },
  { key: 'byo_sdk', label: 'BYO + trace', run: byoSdk },
  { key: 'gateway_local', label: 'Local gateway', run: () => gateway(LOCAL_BASE, LOCAL_KEY) },
  { key: 'gateway_hosted', label: 'Hosted gateway', run: () => gateway(HOSTED_BASE, HOSTED_KEY) },
];

const samples = Object.fromEntries(PATHS.map((p) => [p.key, []]));
const failures = Object.fromEntries(PATHS.map((p) => [p.key, 0]));

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

async function main() {
  console.log(`rounds=${ROUNDS} warmup=${WARMUP} paths=${PATHS.length}\n`);

  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const measured = round >= WARMUP;
    // Rotate the running order each round so no path is always first (and so
    // always pays for whatever the previous path left warm).
    const order = PATHS.map((_, i) => PATHS[(i + round) % PATHS.length]);

    for (const path of order) {
      const t0 = performance.now();
      try {
        await path.run();
        const ms = performance.now() - t0;
        if (measured) samples[path.key].push(ms);
      } catch (err) {
        if (measured) failures[path.key]++;
        console.error(`  ! ${path.key}: ${err.message}`);
      }
    }

    if (measured && (round - WARMUP + 1) % 10 === 0) {
      const done = round - WARMUP + 1;
      const line = PATHS.map((p) => {
        const s = [...samples[p.key]].sort((a, b) => a - b);
        return `${p.key}=${Math.round(pct(s, 50))}`;
      }).join('  ');
      console.log(`round ${done}/${ROUNDS}  median  ${line}`);
    }
  }

  console.log('\n=== results ===');
  const table = [];
  for (const p of PATHS) {
    const s = [...samples[p.key]].sort((a, b) => a - b);
    const row = {
      key: p.key,
      label: p.label,
      n: s.length,
      failures: failures[p.key],
      median: Math.round(pct(s, 50)),
      p95: Math.round(pct(s, 95)),
      p99: Math.round(pct(s, 99)),
      min: Math.round(s[0]),
      max: Math.round(s[s.length - 1]),
      mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    };
    table.push(row);
    console.log(
      `${p.label.padEnd(16)} n=${row.n} fail=${row.failures}  median=${row.median}  p95=${row.p95}  p99=${row.p99}  min=${row.min}  max=${row.max}`,
    );
  }

  writeFileSync('results.json', JSON.stringify({ rounds: ROUNDS, warmup: WARMUP, table, samples }, null, 2));
  console.log('\nwrote results.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
