// Must be set BEFORE anything that may read the env at import time.
process.env.GATEWAY_ENCRYPTION_KEY =
  process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { decryptSecret } from './crypto';
import { authHeaders, resetAuthTables, signupTestUser } from '../../test-utils';

const app = createApp();

async function truncateTables(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

/** Rewrites the caller's role in their own team so RBAC tests can act as editor/viewer. */
async function setRole(userId: string, teamId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') {
  await prisma.teamMember.update({ where: { userId_teamId: { userId, teamId } }, data: { role } });
}

const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyzAB12';

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

// ── POST /gateway/connections ───────────────────────────────────────────────

describe('POST /api/v1/gateway/connections', () => {
  it('creates a connection, returns it masked (keyLastFour, no apiKey)', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod OpenAI', apiKey: OPENAI_KEY, config: {} })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.provider).toBe('openai');
    expect(res.body.label).toBe('Prod OpenAI');
    expect(res.body.keyLastFour).toBe('AB12');
    expect(res.body.apiKey).toBeUndefined();
    expect(res.body.secretCiphertext).toBeUndefined();
    expect(res.body.createdBy).toBeDefined();
  });

  it('stores the key encrypted: DB bytes contain no plaintext and decrypt to the original', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod', apiKey: OPENAI_KEY })
      .expect(201);

    const row = await prisma.providerConnection.findUnique({ where: { id: res.body.id } });
    expect(row).not.toBeNull();
    // The ciphertext must not contain the plaintext key.
    expect(Buffer.from(row!.secretCiphertext).toString('utf8')).not.toContain(OPENAI_KEY);
    expect(Buffer.from(row!.secretCiphertext).toString('utf8')).not.toContain('sk-abcdef');
    // But it decrypts back to the exact original.
    expect(decryptSecret(row!.secretCiphertext)).toBe(OPENAI_KEY);
  });

  it('emits a provider_connection_created audit event', async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod', apiKey: OPENAI_KEY })
      .expect(201);

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_created' },
    });
    expect(events).toHaveLength(1);
    expect((events[0].metadata as Record<string, unknown>).connectionId).toBe(res.body.id);
  });

  it('rejects openai_compatible without config.base_url (400)', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai_compatible', label: 'Groq', apiKey: 'gsk_123', config: {} })
      .expect(400);
  });

  it('accepts openai_compatible with a valid base_url (201)', async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({
        provider: 'openai_compatible',
        label: 'Groq',
        apiKey: 'gsk_1234',
        config: { base_url: 'https://api.groq.com/openai/v1' },
      })
      .expect(201);
    expect(res.body.config.base_url).toBe('https://api.groq.com/openai/v1');
  });

  it('returns 403 when an editor tries to create a connection', async () => {
    const ctx = await signupTestUser(app);
    await setRole(ctx.userId, ctx.teamId, 'editor');

    await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Nope', apiKey: OPENAI_KEY })
      .expect(403);
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'x', apiKey: OPENAI_KEY })
      .expect(401);
  });
});

// ── GET /gateway/connections ────────────────────────────────────────────────

describe('GET /api/v1/gateway/connections', () => {
  it('lists connections masked (never the key); viewer can list (200)', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod', apiKey: OPENAI_KEY })
      .expect(201);

    // Demote to viewer — reads must still work.
    await setRole(ctx.userId, ctx.teamId, 'viewer');

    const res = await request(app)
      .get('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].keyLastFour).toBe('AB12');
    expect(res.body[0].apiKey).toBeUndefined();
    expect(res.body[0].secretCiphertext).toBeUndefined();
  });
});

// ── GET /gateway/connections/:id ──────────────────────────────────────────────

describe('GET /api/v1/gateway/connections/:id', () => {
  it("returns 404 for another team's connection (isolation)", async () => {
    const alice = await signupTestUser(app);
    const bob = await signupTestUser(app);

    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(alice))
      .send({ provider: 'openai', label: 'Alice key', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .get(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(bob))
      .expect(404);
  });
});

// ── PATCH /gateway/connections/:id ────────────────────────────────────────────

describe('PATCH /api/v1/gateway/connections/:id', () => {
  it('updates the label (200)', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Old label', apiKey: OPENAI_KEY })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ label: 'New label' })
      .expect(200);

    expect(res.body.label).toBe('New label');
  });

  it('rotating the key changes keyLastFour and re-encrypts to the new key', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Rotate me', apiKey: OPENAI_KEY })
      .expect(201);

    const newKey = 'sk-zzzzzzzzzzzzzzzzzzzzzzzzzz9999';
    const res = await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ apiKey: newKey })
      .expect(200);

    expect(res.body.keyLastFour).toBe('9999');

    const row = await prisma.providerConnection.findUnique({ where: { id: created.body.id } });
    expect(decryptSecret(row!.secretCiphertext)).toBe(newKey);
  });

  it('emits a provider_connection_updated audit event with rotatedKey: true when the key is rotated', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Rotate me', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ apiKey: 'sk-zzzzzzzzzzzzzzzzzzzzzzzzzz9999' })
      .expect(200);

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_updated' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(ctx.userId);
    const metadata = events[0].metadata as Record<string, unknown>;
    expect(metadata.connectionId).toBe(created.body.id);
    expect(metadata.rotatedKey).toBe(true);
  });

  it('emits a provider_connection_updated audit event with rotatedKey: false for a label-only update', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Old label', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ label: 'New label' })
      .expect(200);

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_updated' },
    });
    expect(events).toHaveLength(1);
    const metadata = events[0].metadata as Record<string, unknown>;
    expect(metadata.rotatedKey).toBe(false);
  });
});

// ── DELETE /gateway/connections/:id ───────────────────────────────────────────

describe('DELETE /api/v1/gateway/connections/:id', () => {
  it('deletes (204), emits audit, and a subsequent GET is 404', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Delete me', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .delete(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    await request(app)
      .get(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(404);

    const gone = await prisma.providerConnection.findUnique({ where: { id: created.body.id } });
    expect(gone).toBeNull();

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_deleted' },
    });
    expect(events).toHaveLength(1);
  });
});
