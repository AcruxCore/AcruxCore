import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { hashKey } from './keys.crypto';
import type { TeamRole } from '../../shared/db/schema';
import { authHeaders, resetAuthTables, signupTestUser, type TestAuthContext } from '../../test-utils';

const app = createApp();

/** Canned OpenAI chat-completion body returned by the mocked provider fetch. */
const OPENAI_RESPONSE = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

/** Truncate Phase 2 + Phase 1 tables, children first (FK-safe). */
async function truncate(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

/** Give the team a routable OpenAI credential + a `gpt-4o-mini` model so completions can resolve. */
async function createOpenAiConnection(ctx: TestAuthContext): Promise<void> {
  const conn = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({ provider: 'openai', label: 'default', apiKey: 'sk-fake-openai-key' })
    .expect(201);
  await request(app)
    .post('/api/v1/gateway/models')
    .set(authHeaders(ctx))
    .send({ publicName: 'gpt-4o-mini', upstreamModel: 'gpt-4o-mini', credentialId: conn.body.id })
    .expect(201);
}

/**
 * Seed a user whose ONLY team membership is `teamId` with the given role, linked
 * to a Supabase id, and return an authorized header. requireAuth's find-or-create
 * finds the user by `sub` and resolves their active team to their only membership
 * (`teamId`) — the reliable way to exercise the RBAC matrix on a team the user
 * does not own.
 */
async function seedUserInTeam(
  teamId: string,
  email: string,
  role: TeamRole,
): Promise<{ headers: Record<string, string> }> {
  // Real signup, not a hand-written `users` row: a credential now lives in
  // `auth_accounts`, so a directly-inserted user has no way to authenticate.
  const ctx = await signupTestUser(app, { email });
  await prisma.teamMember.create({ data: { teamId, userId: ctx.userId, role } });
  await request(app)
    .post('/api/v1/auth/switch-team')
    .set(authHeaders(ctx))
    .send({ teamId })
    .expect(200);
  return { headers: authHeaders(ctx) };
}

let fetchSpy: jest.SpyInstance;

beforeAll(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => OPENAI_RESPONSE,
    text: async () => JSON.stringify(OPENAI_RESPONSE),
  } as unknown as Response);
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await truncate();
  await prisma.$disconnect();
});

beforeEach(truncate);

describe('POST /api/v1/gateway/keys', () => {
  it('returns 201 with plaintext key; DB stores only the hash, never the token', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/gateway/keys')
      .set(authHeaders(ctx))
      .send({ name: 'prod-app', allowedModels: ['gpt-4o-mini'], allowedProviders: null, maxRpm: 60 })
      .expect(201);

    expect(res.body.key).toMatch(/^agh_sk_/);
    expect(res.body.keyLastFour).toBe(res.body.key.slice(-4));
    expect(res.body.allowedModels).toEqual(['gpt-4o-mini']);
    expect(res.body.allowedProviders).toBeNull();

    const row = await prisma.virtualKey.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.keyHash).toBe(hashKey(res.body.key)); // hash matches
    expect(JSON.stringify(row)).not.toContain(res.body.key); // token never stored
  });

  it('editor cannot create a key → 403', async () => {
    const { teamId } = await signupTestUser(app);
    const { headers: editorHeaders } = await seedUserInTeam(teamId, 'editor@vk.com', 'editor');

    await request(app)
      .post('/api/v1/gateway/keys')
      .set(editorHeaders)
      .send({ name: 'nope' })
      .expect(403);
  });

  it('viewer lists keys masked → 200, no token/hash fields', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/keys')
      .set(authHeaders(ctx))
      .send({ name: 'listed' })
      .expect(201);

    const { headers: viewerHeaders } = await seedUserInTeam(ctx.teamId, 'viewer@vk.com', 'viewer');
    const res = await request(app)
      .get('/api/v1/gateway/keys')
      .set(viewerHeaders)
      .expect(200);

    expect(res.body.length).toBe(1);
    for (const item of res.body) {
      expect(item.key).toBeUndefined();
      expect(item.keyHash).toBeUndefined();
      expect(item.keyLastFour).toBeDefined();
    }
  });
});

describe('POST /api/v1/gateway/chat/completions via virtual key', () => {
  it('200 and records gateway_requests.virtual_key_id', async () => {
    const ctx = await signupTestUser(app);
    await createOpenAiConnection(ctx);

    const keyRes = await request(app)
      .post('/api/v1/gateway/keys')
      .set(authHeaders(ctx))
      .send({ name: 'app', allowedModels: ['gpt-4o-mini'] })
      .expect(201);
    const token = keyRes.body.key as string;

    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi in one word.' }] })
      .expect(200);

    expect(res.body.choices[0].message.content).toBe('Hi');

    const reqRow = await prisma.gatewayRequest.findFirstOrThrow({ where: { teamId: ctx.teamId } });
    expect(reqRow.virtualKeyId).toBe(keyRes.body.id);
  });

  it('key scoped to gpt-4o-mini requesting claude-3-5-sonnet → 403 MODEL_NOT_ALLOWED', async () => {
    const ctx = await signupTestUser(app);
    await createOpenAiConnection(ctx);

    const keyRes = await request(app)
      .post('/api/v1/gateway/keys')
      .set(authHeaders(ctx))
      .send({ name: 'scoped', allowedModels: ['gpt-4o-mini'] })
      .expect(201);

    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${keyRes.body.key}`)
      .send({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] })
      .expect(403);
    expect(res.body.error.code).toBe('MODEL_NOT_ALLOWED');
  });

  it('revoked key → 401 INVALID_KEY', async () => {
    const ctx = await signupTestUser(app);
    const keyRes = await request(app)
      .post('/api/v1/gateway/keys')
      .set(authHeaders(ctx))
      .send({ name: 'to-revoke' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/gateway/keys/${keyRes.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${keyRes.body.key}`)
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_KEY');
  });

  it("another team's key carries its own team; a random token never resolves", async () => {
    const teamA = await signupTestUser(app);
    const teamB = await signupTestUser(app);
    await createOpenAiConnection(teamB);

    const keyB = await request(app)
      .post('/api/v1/gateway/keys')
      .set(authHeaders(teamB))
      .send({ name: 'B-key', allowedModels: ['gpt-4o-mini'] })
      .expect(201);

    // Calling with team B's key records the request under team B, never team A.
    await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${keyB.body.key}`)
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    const rowsA = await prisma.gatewayRequest.count({ where: { teamId: teamA.teamId } });
    const rowsB = await prisma.gatewayRequest.count({ where: { teamId: teamB.teamId } });
    expect(rowsA).toBe(0);
    expect(rowsB).toBe(1);

    // A made-up token whose hash is not in the DB → 401.
    await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', 'Bearer agh_sk_not_a_real_token')
      .send({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      .expect(401);
  });
});
