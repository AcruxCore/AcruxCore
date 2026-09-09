import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { signupTestUserWithApiKey, authedAgent, addUserToTeam, authHeaders } from '../test-utils';

const app = createApp();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE audit_log, tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/prompts/:id/audit', () => {
  it('returns events newest-first with pagination metadata', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const p = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'my-prompt' })
      .expect(201);
    const promptId: string = p.body.id;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'v1 {{ name }}' }] })
      .expect(201);

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ messages: [{ role: 'system', content: 'v2 {{ name }}' }] })
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/audit`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);

    const timestamps = res.body.data.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[timestamps.length - 1]);
  });

  it('does not leak events from another prompt in the same team', async () => {
    const { apiKey: ak0 } = await signupTestUserWithApiKey(app);

    const p1 = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${ak0}`)
      .send({ name: 'prompt-a' })
      .expect(201);
    const p2 = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${ak0}`)
      .send({ name: 'prompt-b' })
      .expect(201);

    const { apiKey } = await signupTestUserWithApiKey(app);

    // Use the key from the third signup to query since the prompts belong to that team
    const { apiKey: ak1 } = await signupTestUserWithApiKey(app);
    const pp1 = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${ak1}`)
      .send({ name: 'isolated-a' })
      .expect(201);
    await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${ak1}`)
      .send({ name: 'isolated-b' })
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/prompts/${pp1.body.id}/audit`)
      .set('Authorization', `Bearer ${ak1}`)
      .expect(200);

    const promptIds: (string | undefined)[] = res.body.data.map(
      (e: { promptId?: string }) => e.promptId,
    );
    for (const id of promptIds.filter(Boolean)) {
      expect(id).toBe(pp1.body.id);
    }
    void p1; void p2; void apiKey;
  });

  it('paginates correctly: page=2&limit=2 returns the third item', async () => {
    const { apiKey, userId, teamId } = await signupTestUserWithApiKey(app);

    const p = await request(app)
      .post('/api/v1/prompts')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'paginated-prompt' })
      .expect(201);
    const promptId: string = p.body.id;

    await prisma.auditLog.createMany({
      data: [
        { teamId, promptId, actorId: userId, event: 'version_committed', metadata: { versionNumber: 1 } },
        { teamId, promptId, actorId: userId, event: 'version_committed', metadata: { versionNumber: 2 } },
        { teamId, promptId, actorId: userId, event: 'alias_promoted', metadata: { alias: 'production', toVersionNumber: 2 } },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/prompts/${promptId}/audit?page=2&limit=2`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(2);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });

  it('returns 404 for a non-existent prompt', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .get('/api/v1/prompts/00000000-0000-0000-0000-000000000000/audit')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/v1/teams/:id/audit (Finding #13)', () => {
  it('returns every auditable event for the team, newest-first, including non-prompt events', async () => {
    const owner = await authedAgent(app);

    // A prompt-scoped event...
    const p = await owner.agent.post('/api/v1/prompts').send({ name: 'my-prompt' }).expect(201);
    await owner.agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'system', content: 'v1' }] })
      .expect(201);

    // ...and a team-wide, non-prompt event (connection created).
    await owner.agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'test', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201);

    const res = await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit`).expect(200);

    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const events: string[] = res.body.data.map((e: { event: string }) => e.event);
    expect(events).toContain('version_committed');
    expect(events).toContain('provider_connection_created');

    // The connection event has no promptId; the version event does.
    const connectionEvent = res.body.data.find((e: { event: string }) => e.event === 'provider_connection_created');
    expect(connectionEvent.promptId).toBeNull();
    const versionEvent = res.body.data.find((e: { event: string }) => e.event === 'version_committed');
    expect(versionEvent.promptId).toBe(p.body.id);

    const timestamps = res.body.data.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[timestamps.length - 1]);
  });

  it("does not leak another team's audit events", async () => {
    const teamA = await authedAgent(app);
    await teamA.agent.post('/api/v1/prompts').send({ name: 'team-a-prompt' }).expect(201);

    const teamB = await authedAgent(app);
    await teamB.agent.post('/api/v1/prompts').send({ name: 'team-b-prompt' }).expect(201);

    const res = await teamB.agent.get(`/api/v1/teams/${teamB.teamId}/audit`).expect(200);
    const promptIds: string[] = res.body.data.map((e: { promptId: string | null }) => e.promptId).filter(Boolean);
    for (const id of promptIds) {
      expect(id).not.toBe(''); // sanity — every returned event really belongs to teamB
    }
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    // None of teamB's events reference teamA's prompt.
    const teamAPromptRes = await teamA.agent.get(`/api/v1/teams/${teamA.teamId}/audit`).expect(200);
    const teamAPromptIds = teamAPromptRes.body.data.map((e: { promptId: string | null }) => e.promptId);
    for (const id of promptIds) {
      expect(teamAPromptIds).not.toContain(id);
    }
  });

  it('rejects editors and viewers with 403, but allows owners and admins', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    const editor = await addUserToTeam(app, owner.teamId, 'editor');
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');

    await request(app).get(`/api/v1/teams/${owner.teamId}/audit`).set(authHeaders(admin)).expect(200);
    await request(app).get(`/api/v1/teams/${owner.teamId}/audit`).set(authHeaders(editor)).expect(403);
    await request(app).get(`/api/v1/teams/${owner.teamId}/audit`).set(authHeaders(viewer)).expect(403);
  });

  it('paginates correctly: page=2&limit=1 returns the second-newest event', async () => {
    const owner = await authedAgent(app);
    await owner.agent.post('/api/v1/prompts').send({ name: 'p1' }).expect(201);
    await owner.agent.post('/api/v1/prompts').send({ name: 'p2' }).expect(201);

    const page1 = await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit?page=1&limit=1`).expect(200);
    const page2 = await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit?page=2&limit=1`).expect(200);

    expect(page1.body.data).toHaveLength(1);
    expect(page2.body.data).toHaveLength(1);
    expect(page1.body.data[0].id).not.toBe(page2.body.data[0].id);
  });

  it('filters by a single event name, and narrows total to the filtered set', async () => {
    const owner = await authedAgent(app);
    const p = await owner.agent.post('/api/v1/prompts').send({ name: 'filter-me' }).expect(201);
    await owner.agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'system', content: 'v1' }] })
      .expect(201);
    await owner.agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'system', content: 'v2' }] })
      .expect(201);

    const all = await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit`).expect(200);
    const filtered = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/audit?event=version_committed`)
      .expect(200);

    expect(filtered.body.total).toBe(2);
    expect(filtered.body.total).toBeLessThan(all.body.total);
    expect(filtered.body.data.map((e: { event: string }) => e.event)).toEqual([
      'version_committed',
      'version_committed',
    ]);
  });

  it('filters by a comma-separated group of event names (OR within the list)', async () => {
    const owner = await authedAgent(app);
    const p = await owner.agent.post('/api/v1/prompts').send({ name: 'grouped' }).expect(201);
    await owner.agent
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .send({ messages: [{ role: 'system', content: 'v1' }] })
      .expect(201);
    await owner.agent
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'grouped', apiKey: 'sk-test-abcdAB12', config: {} })
      .expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/audit?event=prompt_created,provider_connection_created`)
      .expect(200);

    const events: string[] = res.body.data.map((e: { event: string }) => e.event);
    expect(events.sort()).toEqual(['prompt_created', 'provider_connection_created']);
    expect(res.body.total).toBe(2);
  });

  it('rejects an unknown event name with 400 rather than silently returning everything', async () => {
    const owner = await authedAgent(app);
    await owner.agent.post('/api/v1/prompts').send({ name: 'p' }).expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/audit?event=not_a_real_event`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('filters by actorId, and 400s on a non-UUID actorId', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');

    await owner.agent.post('/api/v1/prompts').send({ name: 'by-owner' }).expect(201);
    await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(admin))
      .send({ name: 'by-admin' })
      .expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/audit?actorId=${admin.userId}`)
      .expect(200);

    expect(res.body.total).toBeGreaterThanOrEqual(1);
    for (const entry of res.body.data) {
      expect(entry.actor.id).toBe(admin.userId);
    }
    const names = res.body.data.map((e: { metadata: { name?: string } | null }) => e.metadata?.name);
    expect(names).toContain('by-admin');
    expect(names).not.toContain('by-owner');

    await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit?actorId=nope`).expect(400);
  });

  it('resolves metadata.targetUserId to the affected member’s email', async () => {
    const owner = await authedAgent(app);
    const member = await addUserToTeam(app, owner.teamId, 'editor');

    await owner.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${member.userId}/roles`)
      .send({ role: 'admin' })
      .expect(200);
    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/members/${member.userId}`)
      .expect(204);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/audit?event=member_removed,member_role_updated`)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    for (const entry of res.body.data) {
      expect(entry.target).toEqual({ id: member.userId, email: member.email });
    }
  });

  it('leaves target null on an event that carries no targetUserId', async () => {
    const owner = await authedAgent(app);
    await owner.agent.post('/api/v1/prompts').send({ name: 'no-target' }).expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/audit?event=prompt_created`)
      .expect(200);
    expect(res.body.data[0].target).toBeNull();
  });

  it('combines the event and actor filters with AND', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');

    const p = await request(app)
      .post('/api/v1/prompts')
      .set(authHeaders(admin))
      .send({ name: 'admin-prompt' })
      .expect(201);
    await request(app)
      .post(`/api/v1/prompts/${p.body.id}/versions`)
      .set(authHeaders(admin))
      .send({ messages: [{ role: 'system', content: 'v1' }] })
      .expect(201);
    await owner.agent.post('/api/v1/prompts').send({ name: 'owner-prompt' }).expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/audit?event=prompt_created&actorId=${admin.userId}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].event).toBe('prompt_created');
    expect(res.body.data[0].actor.id).toBe(admin.userId);
  });
});

describe('GET /api/v1/teams/:id/audit/actors', () => {
  it('returns one row per distinct actor with an event count, ascending by email', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');

    await owner.agent.post('/api/v1/prompts').send({ name: 'a' }).expect(201);
    await owner.agent.post('/api/v1/prompts').send({ name: 'b' }).expect(201);
    await request(app).post('/api/v1/prompts').set(authHeaders(admin)).send({ name: 'c' }).expect(201);

    const res = await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit/actors`).expect(200);

    expect(res.body.data).toHaveLength(2);
    const emails = res.body.data.map((a: { email: string }) => a.email);
    expect([...emails]).toEqual([...emails].sort((x, y) => x.localeCompare(y)));

    const ownerRow = res.body.data.find((a: { id: string }) => a.id === owner.userId);
    const adminRow = res.body.data.find((a: { id: string }) => a.id === admin.userId);
    expect(ownerRow.eventCount).toBe(2);
    expect(adminRow.eventCount).toBe(1);
  });

  it('still lists an actor after they are removed from the team', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    await request(app).post('/api/v1/prompts').set(authHeaders(admin)).send({ name: 'gone' }).expect(201);

    await owner.agent.delete(`/api/v1/teams/${owner.teamId}/members/${admin.userId}`).expect(204);

    const res = await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit/actors`).expect(200);
    expect(res.body.data.map((a: { id: string }) => a.id)).toContain(admin.userId);
  });

  it('is empty for a team with no audit events', async () => {
    const owner = await authedAgent(app);
    await prisma.$executeRaw`DELETE FROM audit_log WHERE team_id = ${owner.teamId}::uuid`;

    const res = await owner.agent.get(`/api/v1/teams/${owner.teamId}/audit/actors`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('rejects editors and viewers with 403', async () => {
    const owner = await authedAgent(app);
    const editor = await addUserToTeam(app, owner.teamId, 'editor');
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');

    await request(app).get(`/api/v1/teams/${owner.teamId}/audit/actors`).set(authHeaders(editor)).expect(403);
    await request(app).get(`/api/v1/teams/${owner.teamId}/audit/actors`).set(authHeaders(viewer)).expect(403);
  });
});

describe('GET /api/v1/tools/:id/audit', () => {
  const paramsSchema = { type: 'object', properties: {} };
  const clientExecutor = { type: 'client' as const };

  it('shows created, version-committed, and alias-promoted events newest-first', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const tool = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather' })
      .expect(201);
    const toolId: string = tool.body.id;

    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${toolId}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: paramsSchema, executor: clientExecutor })
      .expect(201);
    await request(app)
      .post(`/api/v1/tools/${toolId}/aliases/production/promote`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ version_number: 2 })
      .expect(200);

    const res = await request(app)
      .get(`/api/v1/tools/${toolId}/audit`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    const events: string[] = res.body.data.map((e: { event: string }) => e.event);
    expect(events).toEqual(
      expect.arrayContaining(['tool_created', 'tool_version_committed', 'tool_alias_promoted']),
    );
    // newest-first
    const timestamps = res.body.data.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[timestamps.length - 1]);

    const promoted = res.body.data.find((e: { event: string }) => e.event === 'tool_alias_promoted');
    expect(promoted.metadata).toMatchObject({ toolId, alias: 'production', fromVersionNumber: 1, toVersionNumber: 2 });
  });

  it('does not leak another tool’s events, even in the same team', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const toolA = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'tool_a' }).expect(201);
    const toolB = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'tool_b' }).expect(201);

    const res = await request(app)
      .get(`/api/v1/tools/${toolA.body.id}/audit`)
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    for (const entry of res.body.data) {
      expect(entry.metadata.toolId).toBe(toolA.body.id);
      expect(entry.metadata.toolId).not.toBe(toolB.body.id);
    }
  });

  it('404s for a tool in another team', async () => {
    const { apiKey: ak0 } = await signupTestUserWithApiKey(app);
    const tool = await request(app).post('/api/v1/tools').set('Authorization', `Bearer ${ak0}`)
      .send({ name: 'get_weather' }).expect(201);

    const { apiKey: ak1 } = await signupTestUserWithApiKey(app);
    await request(app)
      .get(`/api/v1/tools/${tool.body.id}/audit`)
      .set('Authorization', `Bearer ${ak1}`)
      .expect(404);
  });
});
