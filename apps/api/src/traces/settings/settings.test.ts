import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

async function truncate(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, team_trace_settings, audit_log, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
}

async function setRole(userId: string, teamId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') {
  await prisma.teamMember.update({ where: { userId_teamId: { userId, teamId } }, data: { role } });
}

beforeEach(truncate);
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('GET /api/v1/traces/settings', () => {
  it('returns the lazy default (capturePayloads true) when no row exists', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/traces/settings').expect(200);
    expect(res.body.capturePayloads).toBe(true);
    expect(res.body.updatedAt).toBeNull();
  });

  it('a viewer can read settings (200)', async () => {
    const { agent, userId, teamId } = await authedAgent(app);
    await setRole(userId, teamId, 'viewer');
    await agent.get('/api/v1/traces/settings').expect(200);
  });

  it('401 without authentication', async () => {
    await request(app).get('/api/v1/traces/settings').expect(401);
  });
});

describe('PUT /api/v1/traces/settings', () => {
  it('an owner toggles capture on, gets the settings back, and an audit event is written', async () => {
    const { agent, teamId } = await authedAgent(app);
    const res = await agent.put('/api/v1/traces/settings').send({ capturePayloads: true }).expect(200);
    expect(res.body.capturePayloads).toBe(true);
    expect(res.body.updatedAt).not.toBeNull();

    const row = await prisma.teamTraceSettings.findUnique({ where: { teamId } });
    expect(row!.capturePayloads).toBe(true);

    const events = await prisma.auditLog.findMany({ where: { teamId, event: 'trace_settings_updated' } });
    expect(events).toHaveLength(1);
    expect((events[0].metadata as Record<string, unknown>).capturePayloads).toBe(true);
  });

  it('an editor is forbidden from toggling capture (403)', async () => {
    const { agent, userId, teamId } = await authedAgent(app);
    await setRole(userId, teamId, 'editor');
    await agent.put('/api/v1/traces/settings').send({ capturePayloads: true }).expect(403);
  });

  it('a viewer is forbidden from toggling capture (403)', async () => {
    const { agent, userId, teamId } = await authedAgent(app);
    await setRole(userId, teamId, 'viewer');
    await agent.put('/api/v1/traces/settings').send({ capturePayloads: true }).expect(403);
  });

  it('a team-scoped API key (no req.user) is forbidden from toggling capture (403)', async () => {
    const { agent, teamId } = await authedAgent(app);
    const res = await agent
      .post(`/api/v1/teams/${teamId}/api-keys`)
      .send({ name: 'CI key' })
      .expect(201);

    await request(app)
      .put('/api/v1/traces/settings')
      .set('Authorization', `Bearer ${res.body.key}`)
      .send({ capturePayloads: true })
      .expect(403);
  });

  it('rejects a non-boolean capturePayloads (400 VALIDATION_ERROR)', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.put('/api/v1/traces/settings').send({ capturePayloads: 'yes' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
