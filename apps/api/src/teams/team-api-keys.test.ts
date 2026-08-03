import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { authedAgent } from '../test-utils';
import { API_KEY_PREFIX } from '../api-keys/api-keys.crypto';

const app = createApp();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    team_invites, audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/v1/teams/:id/api-keys', () => {
  it('owner creates a team key and gets the full key once', async () => {
    const owner = await authedAgent(app, { email: 'owner@teamkeys.test' });
    const res = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/api-keys`)
      .send({ name: 'CI key' })
      .expect(201);

    expect(res.body.key).toBeDefined();
    expect(res.body.key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(res.body.name).toBe('CI key');
  });

  it('returns 403 when viewer tries to create a team key', async () => {
    const owner = await authedAgent(app, { email: 'owner@teamkeys2.test' });
    const viewer = await authedAgent(app, { email: 'viewer@teamkeys2.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: viewer.userId, role: 'viewer' },
    });

    await viewer.agent
      .post(`/api/v1/teams/${owner.teamId}/api-keys`)
      .send({ name: 'CI' })
      .expect(403);
  });
});

describe('GET /api/v1/teams/:id/api-keys', () => {
  it('lists team keys with masked value', async () => {
    const owner = await authedAgent(app, { email: 'owner@listteamkeys.test' });

    await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/api-keys`)
      .send({ name: 'my-ci-key' })
      .expect(201);

    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/api-keys`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('my-ci-key');
    expect(res.body[0].lastFour).toBeDefined();
    expect(res.body[0].key).toBeUndefined(); // full key never returned in list
  });
});

describe('Team key auth behaviour', () => {
  it('team key can list prompts (read-only)', async () => {
    const owner = await authedAgent(app, { email: 'owner@teamkeyauth.test' });

    const keyRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/api-keys`)
      .send({ name: 'read-only' })
      .expect(201);

    const teamKey = keyRes.body.key as string;

    const res = await request(app)
      .get('/api/v1/prompts')
      .set('Authorization', `Bearer ${teamKey}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('team key gets 403 when trying to create an invite', async () => {
    const owner = await authedAgent(app, { email: 'owner@teamkeyauth2.test' });

    const keyRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/api-keys`)
      .send({ name: 'CI' })
      .expect(201);

    const teamKey = keyRes.body.key as string;

    const res = await request(app)
      .post(`/api/v1/teams/${owner.teamId}/invites`)
      .set('Authorization', `Bearer ${teamKey}`)
      .send({ roles: ['editor'] })
      .expect(403);

    expect(res.body.error.code).toBe('TEAM_KEY_NOT_PERMITTED');
  });
});

describe('DELETE /api/v1/teams/:id/api-keys/:keyId', () => {
  it('owner revokes a team key', async () => {
    const owner = await authedAgent(app, { email: 'owner@revoketeamkey.test' });

    const createRes = await owner.agent
      .post(`/api/v1/teams/${owner.teamId}/api-keys`)
      .send({ name: 'to-revoke' })
      .expect(201);

    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/api-keys/${createRes.body.id}`)
      .expect(204);

    // Key no longer appears in the list
    const listRes = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/api-keys`)
      .expect(200);

    expect(listRes.body.length).toBe(0);
  });

  it('returns 404 for unknown key id', async () => {
    const owner = await authedAgent(app, { email: 'owner@revoketeamkey2.test' });
    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/api-keys/00000000-0000-0000-0000-000000000000`)
      .expect(404);
  });
});
