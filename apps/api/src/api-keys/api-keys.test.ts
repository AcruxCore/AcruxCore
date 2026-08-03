import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { authHeaders, resetAuthTables, signupTestUser } from '../test-utils';
import { hashKey, API_KEY_PREFIX } from './api-keys.crypto';

const app = createApp();

async function truncateTables(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

// ── POST /api-keys ─────────────────────────────────────────────────────────

describe('POST /api/v1/api-keys', () => {
  it('creates a key and returns it in full (only time the full key is shown)', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'My dev key' })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(res.body.name).toBe('My dev key');
    expect(res.body.createdAt).toBeDefined();
  });

  it('creates a key without a name when name is omitted', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({})
      .expect(201);

    expect(res.body.name).toBeNull();
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .post('/api/v1/api-keys')
      .send({ name: 'key' })
      .expect(401);
  });
});

// ── GET /api-keys ──────────────────────────────────────────────────────────

describe('GET /api/v1/api-keys', () => {
  it('returns a list with lastFour only — full key value is never included', async () => {
    const ctx = await signupTestUser(app);

    // Create a key
    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'My key' })
      .expect(201);

    const fullKey = createRes.body.key as string;

    // List keys
    const res = await request(app)
      .get('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].lastFour).toBe(fullKey.slice(-4));
    expect(res.body[0].key).toBeUndefined(); // full key must NOT be present
    expect(res.body[0].name).toBe('My key');
  });

  it('returns an empty array when no keys exist', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .get('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .get('/api/v1/api-keys')
      .expect(401);
  });
});

// ── DELETE /api-keys/:id ───────────────────────────────────────────────────

describe('DELETE /api/v1/api-keys/:id', () => {
  it('soft-revokes the key — sets revoked_at in DB', async () => {
    const ctx = await signupTestUser(app);

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({})
      .expect(201);

    const keyId = createRes.body.id as string;

    await request(app)
      .delete(`/api/v1/api-keys/${keyId}`)
      .set(authHeaders(ctx))
      .expect(204);

    // Verify soft-delete in DB
    const row = await prisma.apiKey.findUnique({
      where: { id: keyId },
    });

    expect(row!.revokedAt).not.toBeNull();
  });

  it('revoked key no longer appears in GET /api-keys list', async () => {
    const ctx = await signupTestUser(app);

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'temp' });

    const keyId = createRes.body.id as string;

    await request(app)
      .delete(`/api/v1/api-keys/${keyId}`)
      .set(authHeaders(ctx))
      .expect(204);

    const listRes = await request(app)
      .get('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .expect(200);

    expect(listRes.body).toHaveLength(0);
  });

  it("returns 404 when trying to revoke another user's key", async () => {
    const alice = await signupTestUser(app);
    const bob = await signupTestUser(app);

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(alice))
      .send({});

    const aliceKeyId = createRes.body.id as string;

    // Bob tries to revoke Alice's key
    await request(app)
      .delete(`/api/v1/api-keys/${aliceKeyId}`)
      .set(authHeaders(bob))
      .expect(404);
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .delete('/api/v1/api-keys/some-uuid')
      .expect(401);
  });
});

// ── requireApiKey middleware ────────────────────────────────────────────────

describe('requireApiKey middleware — authenticating via Bearer token', () => {
  it('a valid Bearer key authenticates the request (GET /api-keys returns 200)', async () => {
    const ctx = await signupTestUser(app);

    // Generate an API key via session
    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'sdk key' });

    const apiKey = createRes.body.key as string;

    // Use the key to hit GET /api-keys with Bearer
    const res = await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    // Should return the list — authentication succeeded
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a revoked key is rejected with 401', async () => {
    const ctx = await signupTestUser(app);

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({});

    const apiKey = createRes.body.key as string;
    const keyId = createRes.body.id as string;

    // Revoke it
    await request(app)
      .delete(`/api/v1/api-keys/${keyId}`)
      .set(authHeaders(ctx))
      .expect(204);

    // Attempt to use the revoked key
    await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(401);
  });

  it('a malformed Authorization header is rejected with 401', async () => {
    await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', 'Basic sometoken')
      .expect(401);
  });

  it('a well-formed but unissued token is rejected', async () => {
    await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${API_KEY_PREFIX}totallyMadeUpTokenValue000000000000000000`)
      .expect(401);
  });

  it('a revoked key is indistinguishable from an unknown key', async () => {
    const ctx = await signupTestUser(app);

    const { body: created } = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'revoke-parity' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/api-keys/${created.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    const revoked = await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${created.key}`)
      .expect(401);

    const unknown = await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${API_KEY_PREFIX}anotherTokenNeverIssued0000000000000000`)
      .expect(401);

    expect(revoked.body).toEqual(unknown.body);
  });
});

// ── hash-on-store ──────────────────────────────────────────────────────────

describe('API key storage — hash on store', () => {
  it('created key is prefixed, returned once, and stored only as a hash', async () => {
    const ctx = await signupTestUser(app);

    const { body } = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'hash-check' })
      .expect(201);

    expect(body.key.startsWith(API_KEY_PREFIX)).toBe(true);

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.keyHash).toBe(hashKey(body.key));
    expect(row.keyLastFour).toBe(body.key.slice(-4));

    // The plaintext must not be recoverable from any column of the row.
    expect(JSON.stringify(row)).not.toContain(body.key);
  });

  it('listing a key reports the stored lastFour, not a hash fragment', async () => {
    const ctx = await signupTestUser(app);

    const { body: created } = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'mask-check' })
      .expect(201);

    const { body: list } = await request(app)
      .get('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .expect(200);

    const found = list.find((k: { id: string }) => k.id === created.id);
    expect(found.lastFour).toBe(created.key.slice(-4));
    expect(found).not.toHaveProperty('key');
  });
});

// ── audit logging ────────────────────────────────────────────────────────

describe('API key create/revoke audit trail', () => {
  it('records an api_key_generated audit event on create', async () => {
    const ctx = await signupTestUser(app);

    const { body: created } = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'audited key' })
      .expect(201);

    const rows = await prisma.auditLog.findMany({ where: { event: 'api_key_generated' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.teamId).toBe(ctx.teamId);
    expect(rows[0]!.actorId).toBe(ctx.userId);
    expect((rows[0]!.metadata as Record<string, unknown>)['apiKeyId']).toBe(created.id);
  });

  it('records an api_key_revoked audit event on revoke', async () => {
    const ctx = await signupTestUser(app);

    const { body: created } = await request(app)
      .post('/api/v1/api-keys')
      .set(authHeaders(ctx))
      .send({ name: 'to revoke' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/api-keys/${created.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    const rows = await prisma.auditLog.findMany({ where: { event: 'api_key_revoked' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.teamId).toBe(ctx.teamId);
    expect(rows[0]!.actorId).toBe(ctx.userId);
    expect((rows[0]!.metadata as Record<string, unknown>)['apiKeyId']).toBe(created.id);
  });
});
