// Must be set BEFORE anything that may read the env at import time.
process.env.GATEWAY_ENCRYPTION_KEY =
  process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authHeaders, resetAuthTables, signupTestUser, type TestAuthContext } from '../../test-utils';

const app = createApp();

/** Canned OpenAI-shaped success body for the mocked provider fetch (Test endpoint). */
const OK_BODY = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

async function truncate(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

async function setRole(userId: string, teamId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') {
  await prisma.teamMember.update({ where: { userId_teamId: { userId, teamId } }, data: { role } });
}

/** Creates an openai credential and returns its id. */
async function createCredential(ctx: TestAuthContext, label = 'OpenAI Prod'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({ provider: 'openai', label, apiKey: 'sk-abcdefghijklmnopqrstuvwxyzAB12' })
    .expect(201);
  return res.body.id as string;
}

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

describe('POST /api/v1/gateway/models', () => {
  it('registers a model and prefills pricing for a known upstream model', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);

    const res = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'fast', upstreamModel: 'gpt-4o-mini', credentialId })
      .expect(201);

    expect(res.body.publicName).toBe('fast');
    expect(res.body.upstreamModel).toBe('gpt-4o-mini');
    expect(res.body.provider).toBe('openai');
    expect(res.body.credentialLabel).toBe('OpenAI Prod');
    // gpt-4o-mini is in the static registry → prices prefilled.
    expect(res.body.inputPricePerM).toBe(0.15);
    expect(res.body.outputPricePerM).toBe(0.6);
    expect(res.body.fallbacks).toEqual([]);
  });

  it('leaves pricing null for an unknown (e.g. OpenRouter) upstream model, honoring manual override', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);

    const unpriced = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'or-claude', upstreamModel: 'anthropic/claude-3.5-sonnet', credentialId })
      .expect(201);
    expect(unpriced.body.inputPricePerM).toBeNull();
    expect(unpriced.body.outputPricePerM).toBeNull();

    const manual = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({
        publicName: 'or-llama',
        upstreamModel: 'meta-llama/llama-3.1-70b',
        credentialId,
        inputPricePerM: 0.9,
        outputPricePerM: 0.9,
      })
      .expect(201);
    expect(manual.body.inputPricePerM).toBe(0.9);
  });

  it('registers a model with an ordered fallback chain', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);

    const backup = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'backup', upstreamModel: 'gpt-4o', credentialId })
      .expect(201);

    const primary = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({
        publicName: 'primary',
        upstreamModel: 'gpt-4o-mini',
        credentialId,
        fallbackModelIds: [backup.body.id],
      })
      .expect(201);

    expect(primary.body.fallbacks).toEqual([{ id: backup.body.id, publicName: 'backup' }]);
  });

  it('rejects an unknown fallback model id (400 INVALID_FALLBACK)', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);

    const res = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({
        publicName: 'primary',
        upstreamModel: 'gpt-4o-mini',
        credentialId,
        fallbackModelIds: ['00000000-0000-0000-0000-000000000000'],
      })
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_FALLBACK');
  });

  it('forbids create for a non-owner/admin (editor → 403)', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);
    await setRole(ctx.userId, ctx.teamId, 'editor');

    await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'x', upstreamModel: 'gpt-4o-mini', credentialId })
      .expect(403);
  });
});

describe('PATCH /api/v1/gateway/models/:id', () => {
  it('updates the upstream model while keeping the public name', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);
    const created = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'fast', upstreamModel: 'gpt-4o-mini', credentialId })
      .expect(201);

    const patched = await request(app)
      .patch(`/api/v1/gateway/models/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ upstreamModel: 'gpt-4o' })
      .expect(200);

    expect(patched.body.publicName).toBe('fast');
    expect(patched.body.upstreamModel).toBe('gpt-4o');
  });
});

describe('DELETE /api/v1/gateway/models/:id', () => {
  it('blocks deleting a model that is used as another model’s fallback (409)', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);
    const backup = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'backup', upstreamModel: 'gpt-4o', credentialId })
      .expect(201);
    await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'primary', upstreamModel: 'gpt-4o-mini', credentialId, fallbackModelIds: [backup.body.id] })
      .expect(201);

    const res = await request(app)
      .delete(`/api/v1/gateway/models/${backup.body.id}`)
      .set(authHeaders(ctx))
      .expect(409);
    expect(res.body.error.code).toBe('MODEL_IS_FALLBACK');
  });
});

describe('DELETE /api/v1/gateway/connections/:id (credential in use)', () => {
  it('blocks deleting a credential still bound to a model (409 CREDENTIAL_IN_USE)', async () => {
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);
    await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'fast', upstreamModel: 'gpt-4o-mini', credentialId })
      .expect(201);

    const res = await request(app)
      .delete(`/api/v1/gateway/connections/${credentialId}`)
      .set(authHeaders(ctx))
      .expect(409);
    expect(res.body.error.code).toBe('CREDENTIAL_IN_USE');
  });
});

describe('POST /api/v1/gateway/models/:id/test', () => {
  it('returns ok:true when the provider responds', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(OK_BODY), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);
    const model = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'fast', upstreamModel: 'gpt-4o-mini', credentialId })
      .expect(201);

    const res = await request(app)
      .post(`/api/v1/gateway/models/${model.body.id}/test`)
      .set(authHeaders(ctx))
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.latencyMs).toBe('number');
  });

  it('returns ok:false with an error when the provider rejects the key', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const ctx = await signupTestUser(app);
    const credentialId = await createCredential(ctx);
    const model = await request(app)
      .post('/api/v1/gateway/models')
      .set(authHeaders(ctx))
      .send({ publicName: 'fast', upstreamModel: 'gpt-4o-mini', credentialId })
      .expect(201);

    const res = await request(app)
      .post(`/api/v1/gateway/models/${model.body.id}/test`)
      .set(authHeaders(ctx))
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  });
});
