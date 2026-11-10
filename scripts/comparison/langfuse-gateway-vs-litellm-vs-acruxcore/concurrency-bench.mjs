/**
 * Concurrency benchmark: open N streaming completions at once through one
 * gateway, and record CPU and memory of that gateway's containers while they run.
 *
 * Each level starts N streams at the same moment, waits for all of them to
 * finish, then pauses before the next level. Every stream asks OpenAI
 * `gpt-6-luna` to count to 60, so each one stays open for a few seconds.
 *
 * CPU and memory come from the containers' cgroup files
 * (/sys/fs/cgroup/system.slice/docker-<id>.scope), sampled every 250 ms. That
 * is Linux with cgroup v2 and the systemd cgroup driver, which is Docker's
 * default on current distributions. CPU is in cores: 1.0 means one core busy.
 *
 * Usage:
 *   node concurrency-bench.mjs idle                 idle memory of every stack
 *   node concurrency-bench.mjs <gateway> [levels]   langfuse | litellm | acruxcore
 *     levels defaults to 10,100,250,500,1000
 *
 * Env vars: the same keys as latency-bench.mjs.
 * Writes results/concurrency-<gateway>.json or results/idle-memory.json.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Each gateway: its endpoint, its auth, the field that caps output, the
 * container that is the gateway process, and every container its stack runs.
 */
const GATEWAYS = {
  langfuse: {
    url: `${process.env.LANGFUSE_GW_BASE_URL ?? 'http://localhost:3031'}/openai/v1/chat/completions`,
    auth: process.env.LANGFUSE_GW_KEY,
    cap: 'max_completion_tokens',
    gateway: 'lfbench-langfuse-ai-gateway-1',
    stackPrefix: 'lfbench-',
  },
  litellm: {
    url: `${process.env.LITELLM_BASE_URL ?? 'http://localhost:4000'}/v1/chat/completions`,
    auth: process.env.LITELLM_KEY,
    cap: 'max_completion_tokens',
    gateway: 'bench-litellm',
    stackPrefix: 'bench-litellm',
  },
  acruxcore: {
    url: `${process.env.ACRUXCORE_BASE_URL ?? 'http://localhost:3097/api/v1'}/gateway/chat/completions`,
    auth: process.env.ACRUXCORE_KEY,
    cap: 'max_tokens',
    gateway: 'acruxcore-local-api',
    stackPrefix: 'acruxcore-local-',
  },
};

/** Names of running containers whose name starts with `prefix`. */
function containers(prefix) {
  return execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
    .split('\n')
    .filter((n) => n.startsWith(prefix));
}

/** The cgroup v2 directory of one container. */
function cgroupDir(name) {
  const id = execFileSync('docker', ['inspect', '-f', '{{.Id}}', name], { encoding: 'utf8' }).trim();
  return `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
}

function readCpuUsec(dir) {
  const line = readFileSync(`${dir}/cpu.stat`, 'utf8').split('\n').find((l) => l.startsWith('usage_usec'));
  return Number(line.split(' ')[1]);
}

function readMemBytes(dir) {
  return Number(readFileSync(`${dir}/memory.current`, 'utf8').trim());
}

const MB = 1024 * 1024;

/**
 * Samples CPU (cores) and memory (MiB) of a set of containers every 250 ms
 * until stopped, and reports the peak and the mean of each.
 */
function startSampler(names) {
  const dirs = names.map(cgroupDir);
  let lastCpu = dirs.map(readCpuUsec);
  let lastT = performance.now();
  const cpu = [];
  const mem = [];
  const timer = setInterval(() => {
    const now = performance.now();
    const cur = dirs.map(readCpuUsec);
    const usedUsec = cur.reduce((a, v, i) => a + (v - lastCpu[i]), 0);
    cpu.push(usedUsec / ((now - lastT) * 1000));
    mem.push(dirs.reduce((a, d) => a + readMemBytes(d), 0) / MB);
    lastCpu = cur;
    lastT = now;
  }, 250);
  return () => {
    clearInterval(timer);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    return {
      cpuCoresPeak: +Math.max(0, ...cpu).toFixed(2),
      cpuCoresMean: +mean(cpu).toFixed(2),
      memMiBPeak: Math.round(Math.max(0, ...mem)),
    };
  };
}

/** One streaming call: time to first content token, total time, and status. */
async function stream(gw) {
  const t0 = performance.now();
  try {
    const res = await fetch(gw.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        reasoning_effort: 'none',
        messages: [{ role: 'user', content: 'Count from 1 to 60, separated by spaces.' }],
        [gw.cap]: 200,
        stream: true,
      }),
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 120) };
    const decoder = new TextDecoder();
    let ttft = null;
    let text = '';
    for await (const chunk of res.body) {
      const s = decoder.decode(chunk, { stream: true });
      if (ttft === null && s.includes('"content":"')) ttft = performance.now() - t0;
      text += s;
    }
    if (!text.includes('[DONE]')) return { ok: false, status: res.status, error: 'stream ended without [DONE]' };
    return { ok: true, ttft, total: performance.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, error: String(err.cause?.code ?? err.message).slice(0, 120) };
  }
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]);
}

async function runLevel(gw, n) {
  const stop = startSampler(containers(gw.stackPrefix));
  const stopGw = startSampler([gw.gateway]);
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: n }, () => stream(gw)));
  const wall = performance.now() - t0;
  const stack = stop();
  const gateway = stopGw();
  const ok = results.filter((r) => r.ok);
  const ttft = ok.map((r) => r.ttft).sort((a, b) => a - b);
  const total = ok.map((r) => r.total).sort((a, b) => a - b);
  const errors = {};
  for (const r of results.filter((x) => !x.ok)) {
    const k = `${r.status} ${r.error}`;
    errors[k] = (errors[k] ?? 0) + 1;
  }
  return {
    streams: n,
    ok: ok.length,
    failed: n - ok.length,
    errors,
    wallMs: Math.round(wall),
    ttftMs: { p50: pct(ttft, 50), p95: pct(ttft, 95) },
    totalMs: { p50: pct(total, 50), p95: pct(total, 95) },
    gateway,
    stack,
  };
}

async function main() {
  mkdirSync('results', { recursive: true });
  const which = process.argv[2];

  if (which === 'idle') {
    const out = {};
    for (const [name, gw] of Object.entries(GATEWAYS)) {
      const names = containers(gw.stackPrefix);
      const per = Object.fromEntries(names.map((c) => [c, Math.round(readMemBytes(cgroupDir(c)) / MB)]));
      out[name] = { gatewayMiB: per[gw.gateway], stackMiB: Object.values(per).reduce((a, b) => a + b, 0), containers: per };
      console.log(name, JSON.stringify(out[name]));
    }
    writeFileSync('results/idle-memory.json', JSON.stringify({ measuredAt: new Date().toISOString(), ...out }, null, 2));
    return;
  }

  const gw = GATEWAYS[which];
  if (!gw || !gw.auth) {
    console.error('usage: node concurrency-bench.mjs idle | langfuse | litellm | acruxcore [levels]');
    process.exit(1);
  }
  const levels = (process.argv[3] ?? '10,100,250,500,1000').split(',').map(Number);
  const cpus = execFileSync('docker', ['inspect', '-f', '{{.HostConfig.NanoCpus}}', gw.gateway], { encoding: 'utf8' }).trim();
  const out = { gateway: which, gatewayCpuLimit: Number(cpus) / 1e9 || 'none', startedAt: new Date().toISOString(), levels: [] };
  for (const n of levels) {
    const r = await runLevel(gw, n);
    out.levels.push(r);
    console.log(
      `${which} n=${n} ok=${r.ok} failed=${r.failed} ttft p50/p95=${r.ttftMs.p50}/${r.ttftMs.p95} ` +
        `gateway cpu peak=${r.gateway.cpuCoresPeak} mem peak=${r.gateway.memMiBPeak}MiB ` +
        `stack cpu peak=${r.stack.cpuCoresPeak} errors=${JSON.stringify(r.errors)}`,
    );
    await new Promise((res) => setTimeout(res, 15000));
  }
  writeFileSync(`results/concurrency-${which}.json`, JSON.stringify(out, null, 2));
  console.log(`wrote results/concurrency-${which}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
