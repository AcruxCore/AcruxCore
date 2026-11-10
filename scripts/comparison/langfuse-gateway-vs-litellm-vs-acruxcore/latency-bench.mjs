/**
 * Interleaved latency benchmark: OpenAI direct vs three self-hosted gateways
 * (Langfuse AI Gateway, LiteLLM proxy, AcruxCore), all on the same machine.
 *
 * Every path ends at the same upstream: OpenAI `gpt-6-luna`, the same API key,
 * the same prompt, `reasoning_effort: "none"` and a 5-token output cap. The
 * model's own time is shared by all paths, so the difference from the direct
 * call is what the gateway adds.
 *
 * Each round runs every path once, in an order that rotates each round, so no
 * path always goes first. A round measures both a non-streaming call (time to
 * the full response) and a streaming call (time to the first content token).
 *
 * Env vars:
 *   OPENAI_API_KEY      the provider key every gateway also holds
 *   LANGFUSE_GW_KEY     a Langfuse gateway key            (base http://localhost:3031)
 *   LITELLM_KEY         a LiteLLM virtual key             (base http://localhost:4000)
 *   ACRUXCORE_KEY       an AcruxCore API key              (base http://localhost:3097/api/v1)
 *   *_BASE_URL          optional overrides for the three bases above
 *
 * Usage: node latency-bench.mjs <label> [rounds] [warmup]
 *   writes results/latency-<label>.json
 *
 * Needs Node 20+ and `npm install` in this folder (undici, for the pinned
 * connection pool described below). Set OPENAI_IP to pin api.openai.com.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { Agent, fetch } from 'undici';

/**
 * api.openai.com resolves to more than one edge address, and on our network
 * a new connection to the far one costs about 250 ms more. A gateway keeps one warm
 * connection, so it stays on whichever edge it reached first. To compare like
 * with like, every path is pinned to one address (OPENAI_IP, also set as
 * `extra_hosts` on each gateway container), and the direct path keeps its
 * connection open for 60 s as a gateway does.
 */
const OPENAI_IP = process.env.OPENAI_IP;
const dispatcher = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connect: OPENAI_IP
    ? {
        lookup: (host, opts, cb) =>
          host === 'api.openai.com'
            ? opts?.all
              ? cb(null, [{ address: OPENAI_IP, family: 4 }])
              : cb(null, OPENAI_IP, 4)
            : import('node:dns').then((dns) => dns.lookup(host, opts, cb)),
      }
    : {},
});

const LABEL = process.argv[2];
if (!LABEL) {
  console.error('usage: node latency-bench.mjs <label> [rounds] [warmup]');
  process.exit(1);
}
const ROUNDS = Number(process.argv[3] ?? 150);
const WARMUP = Number(process.argv[4] ?? 5);

const MODEL = 'gpt-6-luna';
const MESSAGES = [{ role: 'user', content: 'Reply with the single word: pong.' }];

/**
 * The request body for one path. OpenAI, Langfuse and LiteLLM take
 * `max_completion_tokens`. AcruxCore's field is `max_tokens`, which it sends to
 * OpenAI as `max_completion_tokens`, so the upstream request is the same.
 */
function body(capField, stream) {
  return JSON.stringify({
    model: MODEL,
    messages: MESSAGES,
    reasoning_effort: 'none',
    [capField]: 5,
    ...(stream ? { stream: true } : {}),
  });
}

const PATHS = [
  {
    key: 'openai_direct',
    url: 'https://api.openai.com/v1/chat/completions',
    auth: process.env.OPENAI_API_KEY,
    cap: 'max_completion_tokens',
  },
  {
    key: 'langfuse',
    url: `${process.env.LANGFUSE_GW_BASE_URL ?? 'http://localhost:3031'}/openai/v1/chat/completions`,
    auth: process.env.LANGFUSE_GW_KEY,
    cap: 'max_completion_tokens',
  },
  {
    key: 'litellm',
    url: `${process.env.LITELLM_BASE_URL ?? 'http://localhost:4000'}/v1/chat/completions`,
    auth: process.env.LITELLM_KEY,
    cap: 'max_completion_tokens',
  },
  {
    key: 'acruxcore',
    url: `${process.env.ACRUXCORE_BASE_URL ?? 'http://localhost:3097/api/v1'}/gateway/chat/completions`,
    auth: process.env.ACRUXCORE_KEY,
    cap: 'max_tokens',
  },
];

for (const p of PATHS) {
  if (!p.auth) {
    console.error(`missing key for ${p.key}`);
    process.exit(1);
  }
}

/** Non-streaming call: ms until the whole JSON response is read. */
async function full(path) {
  const t0 = performance.now();
  const res = await fetch(path.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${path.auth}`, 'Content-Type': 'application/json' },
    body: body(path.cap, false),
    dispatcher,
  });
  const json = await res.json();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  if (!json.choices?.[0]?.message?.content) throw new Error('empty content');
  return ms;
}

/**
 * Streaming call: ms until the first chunk that carries content, then the
 * stream is read to the end so the connection is released cleanly.
 */
async function ttft(path) {
  const t0 = performance.now();
  const res = await fetch(path.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${path.auth}`, 'Content-Type': 'application/json' },
    body: body(path.cap, true),
    dispatcher,
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  const decoder = new TextDecoder();
  let first = null;
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    if (first === null) {
      for (const line of buf.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.choices?.[0]?.delta?.content) {
            first = performance.now() - t0;
            break;
          }
        } catch {
          // A line split across two network chunks; the next chunk completes it.
        }
      }
      // Keep only the unfinished last line for the next pass.
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    }
  }
  if (first === null) throw new Error('stream had no content chunk');
  return first;
}

const METRICS = { full, ttft };
const samples = {};
const failures = {};
for (const m of Object.keys(METRICS)) {
  samples[m] = Object.fromEntries(PATHS.map((p) => [p.key, []]));
  failures[m] = Object.fromEntries(PATHS.map((p) => [p.key, 0]));
}

/** Nearest-rank percentile of a sorted array. */
function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

/**
 * Median of the per-round differences (gateway minus direct, same round), with
 * a 95% bootstrap interval. Pairing by round cancels most of OpenAI's own
 * drift, which is much larger than any gateway's overhead.
 */
function pairedDelta(a, b) {
  const n = Math.min(a.length, b.length);
  const d = [];
  for (let i = 0; i < n; i++) if (a[i] !== null && b[i] !== null) d.push(a[i] - b[i]);
  const sorted = [...d].sort((x, y) => x - y);
  const boots = [];
  for (let r = 0; r < 2000; r++) {
    const s = [];
    for (let i = 0; i < d.length; i++) s.push(d[Math.floor(Math.random() * d.length)]);
    s.sort((x, y) => x - y);
    boots.push(pct(s, 50));
  }
  boots.sort((x, y) => x - y);
  return { n: d.length, median: pct(sorted, 50), ci95: [pct(boots, 2.5), pct(boots, 97.5)] };
}

async function main() {
  console.log(`label=${LABEL} rounds=${ROUNDS} warmup=${WARMUP}`);
  // Per-round values, null when the call failed, so pairs stay aligned by round.
  const byRound = {};
  for (const m of Object.keys(METRICS)) byRound[m] = Object.fromEntries(PATHS.map((p) => [p.key, []]));

  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const measured = round >= WARMUP;
    const order = PATHS.map((_, i) => PATHS[(i + round) % PATHS.length]);
    for (const [m, fn] of Object.entries(METRICS)) {
      for (const path of order) {
        let ms = null;
        try {
          ms = await fn(path);
        } catch (err) {
          if (measured) failures[m][path.key]++;
          console.error(`  ! ${m} ${path.key}: ${err.message}`);
        }
        if (measured) {
          byRound[m][path.key].push(ms);
          if (ms !== null) samples[m][path.key].push(ms);
        }
      }
    }
    if (measured && (round - WARMUP + 1) % 25 === 0) {
      const line = PATHS.map((p) => {
        const s = [...samples.full[p.key]].sort((a, b) => a - b);
        return `${p.key}=${Math.round(pct(s, 50))}`;
      }).join('  ');
      console.log(`round ${round - WARMUP + 1}/${ROUNDS}  full median  ${line}`);
    }
  }

  const summary = {};
  for (const m of Object.keys(METRICS)) {
    summary[m] = {};
    for (const p of PATHS) {
      const s = [...samples[m][p.key]].sort((a, b) => a - b);
      summary[m][p.key] = {
        n: s.length,
        failures: failures[m][p.key],
        median: Math.round(pct(s, 50)),
        p95: Math.round(pct(s, 95)),
        addedVsDirect: p.key === 'openai_direct' ? null : pairedDelta(byRound[m][p.key], byRound[m].openai_direct),
      };
    }
  }

  console.log('\n=== results ===');
  for (const m of Object.keys(METRICS)) {
    console.log(`\n[${m}]`);
    for (const p of PATHS) {
      const r = summary[m][p.key];
      const add = r.addedVsDirect
        ? `  added median=${r.addedVsDirect.median.toFixed(1)}ms CI95=[${r.addedVsDirect.ci95.map((x) => x.toFixed(1)).join(', ')}]`
        : '';
      console.log(`${p.key.padEnd(14)} n=${r.n} fail=${r.failures} median=${r.median} p95=${r.p95}${add}`);
    }
  }

  mkdirSync('results', { recursive: true });
  const out = `results/latency-${LABEL}.json`;
  writeFileSync(
    out,
    JSON.stringify(
      { label: LABEL, model: MODEL, rounds: ROUNDS, warmup: WARMUP, finishedAt: new Date().toISOString(), summary, byRound },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
