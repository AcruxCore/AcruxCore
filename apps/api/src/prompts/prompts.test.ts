import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { addUserToTeam, authHeaders, resetAuthTables, signupTestUser, signupTestUserWithApiKey } from '../test-utils';

const app = createApp();

// ── Setup ──────────────────────────────────────────────────────────────────

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

// ── POST /api/v1/prompts ────────────────────────────────────────────────────

describe('POST /api/v1/prompts', () => {
  it('returns 201 with prompt data and creates DB row', async () => {
    const ctx = await signupTestUser(app);
    const { userId, teamId } = ctx;

    const res = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'my-prompt', description: 'A test prompt' })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('my-prompt');
    expect(res.body.description).toBe('A test prompt');
    expect(res.body.teamId).toBe(teamId);
    expect(res.body.createdBy).toBe(userId);

    // Verify DB row
    const row = await prisma.prompt.findUnique({ where: { id: res.body.id } });
    expect(row).toBeDefined();
    expect(row!.name).toBe('my-prompt');
    expect(row!.deletedAt).toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ description: 'no name' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when name is an empty string', async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: '   ' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when name exceeds 255 characters', async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'a'.repeat(256) })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 when the user has Viewer role', async () => {
    const ctx = await signupTestUser(app);
    const { teamId } = ctx;
    const viewerCtx = await addUserToTeam(app, teamId, 'viewer');

    const res = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(viewerCtx))
      .send({ name: 'viewer-prompt' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows creating two prompts with the same name in the same team', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'duplicate-name' })
      .expect(201);
    await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'duplicate-name' })
      .expect(201);
  });

  it('returns 201 when authenticated with a Bearer API key instead of a session', async () => {
    const { apiKey, teamId } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'bearer-created-prompt' })
      .expect(201);

    expect(res.body.name).toBe('bearer-created-prompt');
    expect(res.body.teamId).toBe(teamId);

    const row = await prisma.prompt.findUnique({ where: { id: res.body.id } });
    expect(row).toBeDefined();
  });
});

// ── GET /api/v1/prompts ─────────────────────────────────────────────────────

describe('GET /api/v1/prompts', () => {
  it('returns only prompts belonging to the current team', async () => {
    const team1 = await signupTestUser(app);
    const team2 = await signupTestUser(app);

    await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(team1))
      .send({ name: 'team1-prompt' });

    await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(team2))
      .send({ name: 'team2-prompt' });

    const res = await request(app)
      .get('/api/v1/prompts')
      .set(authHeaders(team1))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('team1-prompt');
    expect(res.body.total).toBe(1);
  });

  it('filters by search term (case-insensitive match on name)', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'customer-support' });
    await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'billing-help' });

    const res = await request(app)
      .get('/api/v1/prompts?search=CUSTOMER')
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('customer-support');
  });

  it('returns correct page slice and total for pagination', async () => {
    const ctx = await signupTestUser(app);
    for (let i = 1; i <= 7; i++) {
      await request(app)
        .post('/api/v1/prompts')
        .set(authHeaders(ctx))
        .send({ name: `prompt-${i}` });
    }

    const res = await request(app)
      .get('/api/v1/prompts?page=2&limit=5')
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body.total).toBe(7);
    expect(res.body.data).toHaveLength(2); // 7 total, page 2 of limit 5 = 2 items
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(5);
  });

  it('excludes soft-deleted prompts', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'to-delete' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    const res = await request(app)
      .get('/api/v1/prompts')
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ── GET /api/v1/prompts/:id ─────────────────────────────────────────────────

describe('GET /api/v1/prompts/:id', () => {
  it('returns the prompt with correct shape', async () => {
    const ctx = await signupTestUser(app);
    const { userId, teamId } = ctx;
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'fetch-me', description: 'desc' })
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body.id).toBe(created.body.id);
    expect(res.body.name).toBe('fetch-me');
    expect(res.body.description).toBe('desc');
    expect(res.body.teamId).toBe(teamId);
    expect(res.body.createdBy).toBe(userId);
  });

  it('returns 404 when the prompt belongs to a different team', async () => {
    const team1 = await signupTestUser(app);
    const team2 = await signupTestUser(app);

    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(team1))
      .send({ name: 'team1-secret' })
      .expect(201);

    await request(app)
      .get(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(team2))
      .expect(404);
  });

  it('returns 404 after soft-delete', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'gone' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    await request(app)
      .get(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(404);
  });

  it('returns 400 VALIDATION_ERROR (not a 500) when :id is not a UUID', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .get('/api/v1/prompts/not-a-uuid')
      .set(authHeaders(ctx))
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── PATCH /api/v1/prompts/:id ───────────────────────────────────────────────

describe('PATCH /api/v1/prompts/:id', () => {
  it('updates name only, leaves description unchanged', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'old-name', description: 'keep me' })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ name: 'new-name' })
      .expect(200);

    expect(res.body.name).toBe('new-name');
    expect(res.body.description).toBe('keep me');
  });

  it('updates description only, leaves name unchanged', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'stable-name', description: 'old desc' })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ description: 'new desc' })
      .expect(200);

    expect(res.body.name).toBe('stable-name');
    expect(res.body.description).toBe('new desc');
  });

  it('returns 400 when no fields are provided', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'test' })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 when the user has Viewer role', async () => {
    const ctx = await signupTestUser(app);
    const { teamId } = ctx;
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'owner-prompt' })
      .expect(201);

    const viewerCtx = await addUserToTeam(app, teamId, 'viewer');
    await request(app)
      .patch(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(viewerCtx))
      .send({ name: 'hacked' })
      .expect(403);
  });

  it('returns 200 when authenticated with a Bearer API key instead of a session', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'bearer-patch-target' })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/prompts/${created.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'bearer-patched' })
      .expect(200);

    expect(res.body.name).toBe('bearer-patched');
  });
});

// ── DELETE /api/v1/prompts/:id ──────────────────────────────────────────────

describe('DELETE /api/v1/prompts/:id', () => {
  it('returns 204 and sets deleted_at in DB', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'delete-me' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    // Verify DB row has deleted_at set
    const row = await prisma.prompt.findUnique({ where: { id: created.body.id } });
    expect(row!.deletedAt).not.toBeNull();
  });

  it('returns 404 when attempting to delete an already-deleted prompt', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'delete-twice' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(404);
  });

  it('returns 403 when the user has Viewer role', async () => {
    const ctx = await signupTestUser(app);
    const { teamId } = ctx;
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'protected' })
      .expect(201);

    const viewerCtx = await addUserToTeam(app, teamId, 'viewer');
    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(viewerCtx))
      .expect(403);
  });

  it('returns 204 when authenticated with a Bearer API key instead of a session', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const created = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'bearer-delete-target' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(204);

    const row = await prisma.prompt.findUnique({ where: { id: created.body.id } });
    expect(row!.deletedAt).not.toBeNull();
  });
});

// ── Audit log ───────────────────────────────────────────────────────────────

describe('Audit log events', () => {
  it('records prompt_created when a prompt is created', async () => {
    const ctx = await signupTestUser(app);
    const { userId, teamId } = ctx;
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'audited-prompt' })
      .expect(201);

    const entry = await prisma.auditLog.findFirst({
      where: { teamId, promptId: created.body.id },
    });

    expect(entry).toBeDefined();
    expect(entry!.event).toBe('prompt_created');
    expect(entry!.actorId).toBe(userId);
    expect((entry!.metadata as Record<string, unknown>)?.name).toBe('audited-prompt');
  });

  it('records prompt_renamed when name is changed via PATCH', async () => {
    const ctx = await signupTestUser(app);
    const { userId, teamId } = ctx;
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'before-rename' })
      .expect(201);

    await request(app)
      .patch(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ name: 'after-rename' })
      .expect(200);

    const entries = await prisma.auditLog.findMany({
      where: { teamId, promptId: created.body.id },
    });

    const renameEntry = entries.find((e) => e.event === 'prompt_renamed');
    expect(renameEntry).toBeDefined();
    const meta = renameEntry!.metadata as Record<string, unknown>;
    expect(meta.old_name).toBe('before-rename');
    expect(meta.new_name).toBe('after-rename');
  });

  it('records prompt_deleted when a prompt is soft-deleted', async () => {
    const ctx = await signupTestUser(app);
    const { teamId } = ctx;
    const created = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(ctx))
      .send({ name: 'will-be-deleted' })
      .expect(201);

    await request(app)
      .delete(`/api/v1/prompts/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    const entries = await prisma.auditLog.findMany({
      where: { teamId, promptId: created.body.id },
    });

    const deleteEntry = entries.find((e) => e.event === 'prompt_deleted');
    expect(deleteEntry).toBeDefined();
    const meta = deleteEntry!.metadata as Record<string, unknown>;
    expect(meta.name).toBe('will-be-deleted');
  });
});
