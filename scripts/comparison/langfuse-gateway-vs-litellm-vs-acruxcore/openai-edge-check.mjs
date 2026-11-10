/**
 * How much does the OpenAI address you connect to change your latency?
 *
 * api.openai.com resolves to more than one edge address. This script resolves
 * them, measures the TCP and TLS setup to each one, and then sends the same
 * small completion to each address in interleaved rounds, twice per round:
 * once over a kept-open connection (warm) and once over a new connection that
 * is closed afterwards (cold). The model and the request are identical, so any
 * difference is the network path to that address and the connection setup.
 *
 * A gateway keeps one warm connection to its provider, so it pays the setup
 * once. A client that reconnects pays it on every call, and how much depends on
 * which address DNS handed it. Run this before a gateway benchmark: if the
 * addresses differ, pin one for every path (OPENAI_IP in latency-bench.mjs)
 * and keep the direct path's connection open too.
 *
 * Usage: OPENAI_API_KEY=… node openai-edge-check.mjs [rounds]
 * Writes results/openai-edges.json.
 */

import { promises as dns } from 'node:dns';
import { mkdirSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import { Agent, fetch } from 'undici';

const ROUNDS = Number(process.argv[2] ?? 60);
const HOST = 'api.openai.com';
const body = JSON.stringify({
  model: 'gpt-6-luna',
  reasoning_effort: 'none',
  messages: [{ role: 'user', content: 'Reply with the single word: pong.' }],
  max_completion_tokens: 5,
});

/** TCP connect and TLS handshake times to one address, in ms. */
function handshake(ip) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let tcp = null;
    const socket = tls.connect({ host: ip, port: 443, servername: HOST });
    socket.once('connect', () => (tcp = performance.now() - t0));
    socket.once('secureConnect', () => {
      const total = performance.now() - t0;
      socket.end();
      resolve({ tcpMs: Math.round(tcp), tlsMs: Math.round(total - tcp) });
    });
    socket.once('error', reject);
  });
}

/** A connection pool that always dials `ip` for api.openai.com. */
function pinnedAgent(ip) {
  return new Agent({
    keepAliveTimeout: 60_000,
    connect: { lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)) },
  });
}

/** One completion over `dispatcher`, in ms. */
async function call(dispatcher) {
  const t0 = performance.now();
  const res = await fetch(`https://${HOST}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body,
    dispatcher,
  });
  await res.json();
  return performance.now() - t0;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const ips = [...new Set(await dns.resolve4(HOST))].sort();
  console.log(`${HOST} resolves to ${ips.join(', ')}`);
  const edges = {};
  for (const ip of ips) {
    const shakes = [];
    for (let i = 0; i < 5; i++) shakes.push(await handshake(ip));
    edges[ip] = {
      tcpMs: median(shakes.map((s) => s.tcpMs)),
      tlsMs: median(shakes.map((s) => s.tlsMs)),
      agent: pinnedAgent(ip),
      callMs: [],
      coldMs: [],
    };
    console.log(`${ip}  tcp ${edges[ip].tcpMs} ms  tls ${edges[ip].tlsMs} ms  (median of 5)`);
  }

  for (let round = 0; round < ROUNDS + 2; round++) {
    const order = ips.map((_, i) => ips[(i + round) % ips.length]);
    for (const ip of order) {
      // The first two rounds open the warm connections and are not counted.
      const warm = await call(edges[ip].agent);
      if (round >= 2) edges[ip].callMs.push(warm);
      const fresh = pinnedAgent(ip);
      const cold = await call(fresh);
      await fresh.close();
      if (round >= 2) edges[ip].coldMs.push(cold);
    }
  }

  const out = { host: HOST, rounds: ROUNDS, measuredAt: new Date().toISOString(), edges: {} };
  for (const ip of ips) {
    const e = edges[ip];
    const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];
    out.edges[ip] = {
      tcpMs: e.tcpMs,
      tlsMs: e.tlsMs,
      warmMedianMs: Math.round(median(e.callMs)),
      warmP95Ms: Math.round(p95(e.callMs)),
      coldMedianMs: Math.round(median(e.coldMs)),
      coldP95Ms: Math.round(p95(e.coldMs)),
      warmMs: e.callMs.map(Math.round),
      coldMs: e.coldMs.map(Math.round),
    };
    const o = out.edges[ip];
    console.log(`${ip}  warm median ${o.warmMedianMs} ms (p95 ${o.warmP95Ms})  cold median ${o.coldMedianMs} ms (p95 ${o.coldP95Ms})`);
    await e.agent.close();
  }
  mkdirSync('results', { recursive: true });
  writeFileSync('results/openai-edges.json', JSON.stringify(out, null, 2));
  console.log('wrote results/openai-edges.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
