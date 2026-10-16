import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

/** USD per 1M tokens the tests register for the team's own `glm-5.3` model. */
const GLM_INPUT = 0.6;
const GLM_OUTPUT = 2.2;

interface Ctx {
  agent: ReturnType<typeof request.agent>;
  apiKey: string;
  teamId: string;
}

/** Signs up an owner and mints a personal API key for the ingest calls. */
async function signup(): Promise<Ctx> {
  const { agent, teamId } = await authedAgent(app);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 'pricing' }).expect(201);
  return { agent, apiKey: keyRes.body.key as string, teamId };
}

/** Registers a priced gateway model through the real endpoints. */
async function registerPricedModel(
  agent: Ctx['agent'],
  publicName: string,
  upstreamModel: string,
  inputPricePerM: number,
  outputPricePerM: number,
  cachedInputPricePerM?: number,
  provider: 'openai' | 'anthropic' = 'openai',
): Promise<void> {
  const conn = await agent
    .post('/api/v1/gateway/connections')
    .send({ provider, label: `conn ${publicName}`, apiKey: 'sk-test-abcdAB12', config: {} })
    .expect(201);
  await agent
    .post('/api/v1/gateway/models')
    .send({
      publicName,
      upstreamModel,
      credentialId: conn.body.id,
      inputPricePerM,
      outputPricePerM,
      ...(cachedInputPricePerM !== undefined ? { cachedInputPricePerM } : {}),
    })
    .expect(201);
}

/** One OpenInference LLM span as an OTLP/JSON export request. */
function otlpLlmSpan(model: string, prompt: number, completion: number, cacheRead?: number): object {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'pricing-test' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: randomBytes(16).toString('hex'),
                spanId: randomBytes(8).toString('hex'),
                name: 'ChatCompletion',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000500000000',
                attributes: [
                  { key: 'openinference.span.kind', value: { stringValue: 'LLM' } },
                  { key: 'llm.model_name', value: { stringValue: model } },
                  { key: 'llm.token_count.prompt', value: { intValue: prompt } },
                  { key: 'llm.token_count.completion', value: { intValue: completion } },
                  ...(cacheRead !== undefined
                    ? [{ key: 'llm.token_count.prompt_details.cache_read', value: { intValue: cacheRead } }]
                    : []),
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** One native-JSON trace holding a single llm span. */
function nativeLlmTrace(
  model: string,
  prompt: number,
  completion: number,
  costUsd?: number,
  cachedTokens?: number,
): object {
  return {
    name: 'pricing-native',
    spans: [
      {
        spanId: 's1', name: 'chat', kind: 'llm',
        startTime: '2026-10-16T10:00:00.000Z', endTime: '2026-10-16T10:00:01.000Z',
        model,
        usage: {
          promptTokens: prompt,
          completionTokens: completion,
          ...(cachedTokens !== undefined ? { cachedTokens } : {}),
        },
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
    ],
  };
}

/** The stored cost of the team's only span, as a number (or null). */
async function storedCost(teamId: string): Promise<number | null> {
  const spans = await prisma.span.findMany({ where: { teamId } });
  expect(spans).toHaveLength(1);
  return spans[0].costUsd == null ? null : spans[0].costUsd.toNumber();
}

const cost = (inP: number, outP: number, prompt: number, completion: number): number =>
  (prompt / 1e6) * inP + (completion / 1e6) * outP;

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_model_fallbacks, gateway_models, gateway_requests, provider_connections,
    audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('span cost at ingest — team model prices first, registry second', () => {
  it('prices an OTLP span for a model only the team has priced (glm-5.3)', async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'glm-5.3', 'z-ai/glm-5.3', GLM_INPUT, GLM_OUTPUT);

    await request(app)
      .post('/api/v1/traces/otlp')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .set('Content-Type', 'application/json')
      .send(otlpLlmSpan('glm-5.3', 1000, 500))
      .expect(200);

    expect(await storedCost(ctx.teamId)).toBeCloseTo(cost(GLM_INPUT, GLM_OUTPUT, 1000, 500), 9);
  });

  it('matches a span model against the upstream id too, and prices native SDK spans', async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'my-glm', 'glm-5.3', GLM_INPUT, GLM_OUTPUT);

    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [nativeLlmTrace('glm-5.3', 2000, 100)] })
      .expect(200);

    expect(await storedCost(ctx.teamId)).toBeCloseTo(cost(GLM_INPUT, GLM_OUTPUT, 2000, 100), 9);
  });

  it("uses the team's price over the built-in registry for a model both know", async () => {
    const ctx = await signup();
    // The registry prices gpt-4o-mini at 0.15 / 0.6; the team negotiated its own rate.
    await registerPricedModel(ctx.agent, 'gpt-4o-mini', 'gpt-4o-mini', 0.1, 0.4);

    await request(app)
      .post('/api/v1/traces/otlp')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .set('Content-Type', 'application/json')
      .send(otlpLlmSpan('gpt-4o-mini', 1000, 1000))
      .expect(200);

    expect(await storedCost(ctx.teamId)).toBeCloseTo(cost(0.1, 0.4, 1000, 1000), 9);
  });

  it('falls back to the built-in registry when the team has no price', async () => {
    const ctx = await signup();

    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [nativeLlmTrace('gpt-4o-mini-2024-07-18', 1000, 1000)] })
      .expect(200);

    expect(await storedCost(ctx.teamId)).toBeCloseTo(cost(0.15, 0.6, 1000, 1000), 9);
  });

  it('keeps a cost the client sent, and leaves an unknown model unpriced', async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'glm-5.3', 'glm-5.3', GLM_INPUT, GLM_OUTPUT);

    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [nativeLlmTrace('glm-5.3', 1000, 1000, 0.5)] })
      .expect(200);
    expect(await storedCost(ctx.teamId)).toBeCloseTo(0.5, 9);

    const other = await signup();
    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${other.apiKey}`)
      .send({ traces: [nativeLlmTrace('nobody-prices-this', 1000, 1000)] })
      .expect(200);
    expect(await storedCost(other.teamId)).toBeNull();
  });
});

// Issue #594: a traced span carried no cached-token split, so every prompt token was
// charged the full input rate — 56% too high on the scope-check run. Numbers are z.ai's
// glm-5.3 rates: $1.40 input, $0.26 cached input, $4.40 output per 1M tokens.
describe('cached input tokens on traced spans (issue #594)', () => {
  const IN = 1.4;
  const CACHED = 0.26;
  const OUT = 4.4;

  it("bills a native span's cached tokens at the team's cached input price", async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'glm-5.3', 'glm-5.3', IN, OUT, CACHED);

    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [nativeLlmTrace('glm-5.3', 1000, 100, undefined, 800)] })
      .expect(200);

    expect(await storedCost(ctx.teamId)).toBeCloseTo((200 * IN + 800 * CACHED + 100 * OUT) / 1e6, 9);
  });

  it('reads the OpenInference cache_read count off an OTLP span', async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'glm-5.3', 'glm-5.3', IN, OUT, CACHED);

    await request(app)
      .post('/api/v1/traces/otlp')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .set('Content-Type', 'application/json')
      .send(otlpLlmSpan('glm-5.3', 1000, 100, 800))
      .expect(200);

    expect(await storedCost(ctx.teamId)).toBeCloseTo((200 * IN + 800 * CACHED + 100 * OUT) / 1e6, 9);
  });

  it("uses the provider's default cache rate when the team set no cached price", async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'glm-5.3', 'glm-5.3', IN, OUT);

    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [nativeLlmTrace('glm-5.3', 1000, 100, undefined, 800)] })
      .expect(200);

    // OpenAI-style automatic caching: a read costs half the input rate.
    expect(await storedCost(ctx.teamId)).toBeCloseTo((200 * IN + 800 * IN * 0.5 + 100 * OUT) / 1e6, 9);
  });

  // Review of #594: one span with cachedTokens > promptTokens used to fail the whole batch
  // with a 400, so every trace in it was lost. Anthropic's own usage has this shape: its
  // `input_tokens` does not include `cache_read_input_tokens`.
  it('keeps the whole batch when one span reports more cached tokens than prompt tokens', async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'glm-5.3', 'glm-5.3', IN, OUT, CACHED);

    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [nativeLlmTrace('glm-5.3', 1000, 100), nativeLlmTrace('glm-5.3', 40, 100, undefined, 1800)] })
      .expect(200);

    const rows = await prisma.$queryRaw<Array<{ prompt_tokens: number; cached_tokens: number | null; cost_usd: string }>>`
      SELECT prompt_tokens, cached_tokens, cost_usd::text FROM spans WHERE team_id = ${ctx.teamId}::uuid ORDER BY prompt_tokens`;
    expect(rows).toHaveLength(2);
    // The cached count is capped at the prompt count it is part of, and priced that way.
    expect(rows[0]).toMatchObject({ prompt_tokens: 40, cached_tokens: 40 });
    expect(Number(rows[0].cost_usd)).toBeCloseTo((40 * CACHED + 100 * OUT) / 1e6, 9);
  });

  // Review of #594: the cached count priced the span and was then thrown away, so nothing
  // could show which spans were cache hits.
  it("stores a span's cached token count and returns it with the trace", async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'glm-5.3', 'glm-5.3', IN, OUT, CACHED);

    const res = await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [nativeLlmTrace('glm-5.3', 1000, 100, undefined, 800)] })
      .expect(200);
    await request(app)
      .post('/api/v1/traces/otlp')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .set('Content-Type', 'application/json')
      .send(otlpLlmSpan('glm-5.3', 1000, 100, 700))
      .expect(200);

    const rows = await prisma.$queryRaw<Array<{ cached_tokens: number | null }>>`
      SELECT cached_tokens FROM spans WHERE team_id = ${ctx.teamId}::uuid ORDER BY cached_tokens`;
    expect(rows.map((r) => r.cached_tokens)).toEqual([700, 800]);

    const traceId = res.body.traces?.[0]?.traceId ?? res.body.traceIds?.[0] ?? res.body[0]?.traceId;
    const trace = await request(app)
      .get(`/api/v1/traces/${traceId}`)
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .expect(200);
    expect(JSON.stringify(trace.body)).toContain('"cachedTokens":800');
  });

  // Review of #594: the pricer took the cache rate from the provider the span reported,
  // the gateway from the connection that serves the model. A Claude model on a native
  // Anthropic connection, under an id with no "claude" in it, was billed 0.5x on a span
  // and 0.1x on the gateway.
  it("uses the cache rate of the team model's own connection, not the span's provider field", async () => {
    const ctx = await signup();
    await registerPricedModel(ctx.agent, 'house-sonnet', 'house-sonnet', 3, 15, undefined, 'anthropic');

    const trace = nativeLlmTrace('house-sonnet', 1000, 100, undefined, 800) as { spans: Array<Record<string, unknown>> };
    trace.spans[0].provider = 'openai';
    await request(app)
      .post('/api/v1/traces')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ traces: [trace] })
      .expect(200);

    // Anthropic's cache read rate is 0.1x the input price.
    expect(await storedCost(ctx.teamId)).toBeCloseTo((200 * 3 + 800 * 3 * 0.1 + 100 * 15) / 1e6, 9);
  });
});
