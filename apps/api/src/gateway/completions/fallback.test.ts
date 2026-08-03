process.env.GATEWAY_ENCRYPTION_KEY =
  process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authHeaders, resetAuthTables, signupTestUser, type TestAuthContext } from '../../test-utils';

const app = createApp();

// Canned OpenAI-shaped success body.
const OK_BODY = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

/**
 * Mocks global.fetch, routing each provider call by the bearer key in the
 * Authorization header. Unmapped keys → 500. Returns the spy so tests can assert
 * call counts.
 */
function mockProvider(
  routeByKey: Record<string, { status: number; body: unknown }>,
): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
    const auth = new Headers(init?.headers as Record<string, string> | undefined).get('authorization') ?? '';
    const key = auth.replace(/^Bearer\s+/i, '');
    const route = routeByKey[key] ?? { status: 500, body: { error: { message: 'unmapped key' } } };
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

async function truncate(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

// Creates an OpenAI credential with a distinct api key (so the mock can route it).
async function createCred(ctx: TestAuthContext, apiKey: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({ provider: 'openai', label: apiKey, apiKey })
    .expect(201);
  return res.body.id;
}

// Registers a model bound to a credential, optionally with an ordered fallback chain.
async function registerModel(
  ctx: TestAuthContext,
  publicName: string,
  credentialId: string,
  fallbackModelIds: string[] = [],
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/models')
    .set(authHeaders(ctx))
    .send({ publicName, upstreamModel: 'gpt-4o-mini', credentialId, fallbackModelIds })
    .expect(201);
  return res.body.id;
}

function complete(ctx: TestAuthContext, body: Record<string, unknown>) {
  return request(app).post('/api/v1/gateway/chat/completions').set(authHeaders(ctx)).send(body);
}

async function latestRow(teamId: string) {
  return prisma.gatewayRequest.findFirst({ where: { teamId }, orderBy: { createdAt: 'desc' } });
}

type TrailEntry = { modelId: string; credentialId: string; error?: string };

beforeEach(async () => {
  await truncate();
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('gateway explicit per-model fallback / retry', () => {
  it('primary bad key → falls back to the backup model; row records served credential + 401 trail', async () => {
    const ctx = await signupTestUser(app);
    const badCred = await createCred(ctx, 'sk-bad');
    const goodCred = await createCred(ctx, 'sk-good');
    const backup = await registerModel(ctx, 'backup', goodCred);
    const primary = await registerModel(ctx, 'primary', badCred, [backup]);
    mockProvider({
      'sk-bad': { status: 401, body: { error: { message: 'invalid key' } } },
      'sk-good': { status: 200, body: OK_BODY },
    });

    const res = await complete(ctx, { model: 'primary', messages: [{ role: 'user', content: 'hi' }] }).expect(200);
    expect(res.body.choices[0].message.content).toBe('Hi');

    const row = await latestRow(ctx.teamId);
    expect(row!.status).toBe('success');
    expect(row!.providerConnectionId).toBe(goodCred);
    expect(row!.gatewayModelId).toBe(backup);
    const meta = row!.meta as { attempts: number; trail: TrailEntry[] };
    expect(meta.attempts).toBeGreaterThanOrEqual(2);
    expect(meta.trail[0]).toEqual({ modelId: primary, credentialId: badCred, error: '401' });
  });

  it('transient 500 on primary is retried, then falls back to the backup model', async () => {
    const ctx = await signupTestUser(app);
    const flakyCred = await createCred(ctx, 'sk-500');
    const goodCred = await createCred(ctx, 'sk-good');
    const backup = await registerModel(ctx, 'backup', goodCred);
    const primary = await registerModel(ctx, 'primary', flakyCred, [backup]);
    mockProvider({
      'sk-500': { status: 500, body: { error: { message: 'server error' } } },
      'sk-good': { status: 200, body: OK_BODY },
    });

    await complete(ctx, {
      model: 'primary',
      messages: [{ role: 'user', content: 'hi' }],
      gateway: { maxRetries: 1 },
    }).expect(200);

    const row = await latestRow(ctx.teamId);
    expect(row!.providerConnectionId).toBe(goodCred);
    const meta = row!.meta as { attempts: number; trail: TrailEntry[] };
    expect(meta.attempts).toBeGreaterThanOrEqual(3); // flaky x2 + good x1
    expect(meta.trail[0]).toEqual({ modelId: primary, credentialId: flakyCred, error: '500' });
  });

  it('primary + backup both fail (500) → 502 PROVIDER_ERROR; error row lists the full trail', async () => {
    const ctx = await signupTestUser(app);
    const credA = await createCred(ctx, 'sk-a');
    const credB = await createCred(ctx, 'sk-b');
    const backup = await registerModel(ctx, 'backup', credB);
    const primary = await registerModel(ctx, 'primary', credA, [backup]);
    mockProvider({
      'sk-a': { status: 500, body: { error: { message: 'boom' } } },
      'sk-b': { status: 500, body: { error: { message: 'boom' } } },
    });

    const res = await complete(ctx, {
      model: 'primary',
      messages: [{ role: 'user', content: 'hi' }],
      gateway: { maxRetries: 0 },
    }).expect(502);
    expect(res.body.error.code).toBe('PROVIDER_ERROR');

    const row = await latestRow(ctx.teamId);
    expect(row!.status).toBe('error');
    expect(row!.errorCode).toBe('500');
    const meta = row!.meta as { trail: TrailEntry[] };
    expect(meta.trail.map((t) => t.modelId)).toEqual([primary, backup]);
    expect(meta.trail.every((t) => t.error === '500')).toBe(true);
  });

  it('provider 400 → 400 PROVIDER_BAD_REQUEST immediately, no fallback attempted', async () => {
    const ctx = await signupTestUser(app);
    const credA = await createCred(ctx, 'sk-400');
    const credB = await createCred(ctx, 'sk-good');
    const backup = await registerModel(ctx, 'backup', credB);
    const primary = await registerModel(ctx, 'primary', credA, [backup]);
    const spy = mockProvider({
      'sk-400': { status: 400, body: { error: { message: 'bad request' } } },
      'sk-good': { status: 200, body: OK_BODY },
    });

    const res = await complete(ctx, { model: 'primary', messages: [{ role: 'user', content: 'hi' }] }).expect(400);
    expect(res.body.error.code).toBe('PROVIDER_BAD_REQUEST');
    expect(spy).toHaveBeenCalledTimes(1); // only the primary was called

    const row = await latestRow(ctx.teamId);
    expect(row!.status).toBe('error');
    const meta = row!.meta as { trail: TrailEntry[] };
    expect(meta.trail).toHaveLength(1);
    expect(meta.trail[0]).toEqual({ modelId: primary, credentialId: credA, error: '400' });
  });
});
