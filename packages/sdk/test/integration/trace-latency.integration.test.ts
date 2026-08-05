import { acruxcore } from '../../src/client';
import http, { createServer } from 'http';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

/**
 * Does backgrounding the trace report actually remove its cost from a model call?
 *
 * Answered **without deploying anything**, against the real `apps/api` and the real
 * Postgres, by putting a reverse proxy in front of the API that holds `POST …/traces`
 * for `TRACE_DELAY_MS` and forwards every other route untouched. The delay therefore
 * cannot reach the model call by construction: the provider is a separate server on a
 * separate port that the proxy never sees.
 *
 * 539 ms is not arbitrary — it is the median `POST /traces` measured against the hosted
 * API on 2026-07-30, so this reproduces the real remote cost on a local machine.
 *
 * Three arms, rotated per round so warm-up cannot favour one, compared as **paired
 * per-round differences** (each round's arms run back to back, so machine noise cancels):
 *
 * | arm       | what it is                                                            |
 * |-----------|-----------------------------------------------------------------------|
 * | `traced`  | `chat()` with tracing on — the new, backgrounded behaviour             |
 * | `notrace` | `chat({ trace: false })` — the floor                                  |
 * | `awaited` | `chat({ trace: false })` then an awaited `trace()` — what the SDK used |
 * |           | to do internally, i.e. the "before" number, measured in the same run   |
 *
 * The `awaited` arm is what makes this a verification rather than a measurement that
 * could pass trivially: if the harness could not see the cost of an awaited write, it
 * could not claim to have seen it removed.
 *
 * **Opt-in**, because it asserts on wall-clock timing and takes ~15s: a shared CI machine
 * under load would make it flaky, and the deterministic proof of the same behaviour lives
 * in `test/unit/background-trace.test.ts` and `trace.integration.test.ts`.
 *
 *     ACRUXCORE_BENCH=1 npx jest --runInBand --testPathPattern=trace-latency --forceExit
 *
 * Tunable: `BENCH_ROUNDS`, `TRACE_DELAY_MS`, `PROVIDER_DELAY_MS`.
 */
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 15);
const TRACE_DELAY_MS = Number(process.env.TRACE_DELAY_MS ?? 539);
const PROVIDER_DELAY_MS = Number(process.env.PROVIDER_DELAY_MS ?? 100);
/** The gate from the design doc: tracing on must cost less than this over tracing off. */
const GATE_MS = 50;

const describeBench = process.env.ACRUXCORE_BENCH === '1' ? describe : describe.skip;

const app = createApp();
const opened: http.Server[] = [];

/** Starts a server on a free loopback port and returns its port. */
async function start(server: http.Server): Promise<number> {
  opened.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as { port: number }).port;
}

/**
 * Forwards to the real app on `targetPort`, holding `POST …/traces` for `delayMs` first.
 *
 * @param targetPort - Port the real Express app is listening on.
 * @param delayMs - How long to hold a trace write, standing in for a distant server.
 * @returns The proxy server, not yet listening.
 */
function delayingProxy(targetPort: number, delayMs: number): http.Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const forward = () => {
        const upstream = http.request(
          { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on('error', () => {
          res.writeHead(502);
          res.end();
        });
        upstream.end(Buffer.concat(chunks));
      };
      const isTraceWrite = req.method === 'POST' && Boolean(req.url?.endsWith('/traces'));
      if (isTraceWrite) setTimeout(forward, delayMs);
      else forward();
    });
  });
}

/** Median of a sample. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median of the per-round paired differences, which cancels round-to-round noise. */
function pairedMedian(a: number[], b: number[]): number {
  return median(a.map((x, i) => x - b[i]));
}

describeBench('trace reporting latency, against the real API', () => {
  beforeAll(async () => {
    await prisma.$executeRaw`TRUNCATE TABLE
      span_payloads, spans, traces, team_trace_settings,
      prompt_aliases, prompt_versions, audit_log, prompts,
      api_keys, team_members, teams, users
    RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await Promise.all(opened.map((s) => new Promise<void>((r) => s.close(() => r()))));
    await prisma.$disconnect();
  });

  it(
    'tracing on costs no more than tracing off, and every span still lands in Postgres',
    async () => {
      const { apiKey } = await signupTestUserWithApiKey(app);
      const apiPort = await start(createServer(app));
      const proxyPort = await start(delayingProxy(apiPort, TRACE_DELAY_MS));
      const providerPort = await start(
        createServer((_req, res) => {
          // A model call takes real time; the delay is here rather than on the API so the
          // two costs stay separable.
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'c1',
                model: 'stub-model',
                choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
                usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
              }),
            );
          }, PROVIDER_DELAY_MS);
        }),
      );

      const hub = new acruxcore({
        apiKey,
        baseUrl: `http://127.0.0.1:${proxyPort}/api/v1`,
        maxRetries: 0,
      });
      const provider = { baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'p' };
      const call = (extra: Record<string, unknown>) =>
        hub.gateway.chat({ model: 'stub-model', messages: [{ role: 'user', content: 'ping' }], provider, ...extra });

      const traceIds: string[] = [];

      /** Runs one timed call for the named arm. */
      async function arm(name: 'traced' | 'notrace' | 'awaited'): Promise<number> {
        const started = Date.now();
        if (name === 'traced') {
          const result = await call({});
          traceIds.push(result.gateway.traceId!);
        } else if (name === 'notrace') {
          await call({ trace: false });
        } else {
          // Exactly what the SDK used to do: answer the caller, then block on the write.
          const result = await call({ trace: false });
          const { traceId } = await hub.traces.ingest({
            name: 'chat',
            spans: [
              {
                spanId: `awaited-${traceIds.length}`,
                name: result.model,
                kind: 'llm',
                status: 'ok',
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                usage: result.usage,
              },
            ],
          });
          traceIds.push(traceId);
        }
        return Date.now() - started;
      }

      const ARMS = ['traced', 'notrace', 'awaited'] as const;
      const samples: Record<(typeof ARMS)[number], number[]> = { traced: [], notrace: [], awaited: [] };

      for (let round = 0; round < ROUNDS; round++) {
        // Rotate, so no arm is always the one that runs on a cold connection pool.
        for (let i = 0; i < ARMS.length; i++) {
          const name = ARMS[(round + i) % ARMS.length];
          samples[name].push(await arm(name));
        }
      }

      const before = pairedMedian(samples.awaited, samples.notrace);
      const after = pairedMedian(samples.traced, samples.notrace);

      // eslint-disable-next-line no-console
      console.log(
        [
          '',
          `  rounds ${ROUNDS}   provider ${PROVIDER_DELAY_MS}ms   POST /traces +${TRACE_DELAY_MS}ms (real API behind a delaying proxy)`,
          `  traced   median ${median(samples.traced).toFixed(0)} ms`,
          `  notrace  median ${median(samples.notrace).toFixed(0)} ms`,
          `  awaited  median ${median(samples.awaited).toFixed(0)} ms`,
          '',
          `  BEFORE  awaited vs notrace: +${before.toFixed(1)} ms`,
          `  AFTER   traced  vs notrace: +${after.toFixed(1)} ms`,
          '',
        ].join('\n'),
      );

      // The harness can see the cost of an awaited write — without this the "after"
      // number below would prove nothing, since a broken measurement also reads ~0.
      expect(before).toBeGreaterThan(TRACE_DELAY_MS * 0.5);
      // The fix: tracing on is indistinguishable from tracing off.
      expect(after).toBeLessThan(GATE_MS);

      // Nothing was traded away for the latency: every span reached real Postgres.
      await hub.gateway.flush();
      const spans = await prisma.span.findMany({ where: { traceId: { in: traceIds } } });
      expect(traceIds).toHaveLength(ROUNDS * 2);
      expect(spans).toHaveLength(ROUNDS * 2);

      await hub.gateway.close();
    },
    ROUNDS * (PROVIDER_DELAY_MS * 3 + TRACE_DELAY_MS * 2) + 120_000,
  );
});
