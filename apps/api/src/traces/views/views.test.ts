import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

let seq = 0;
function nextEmail(): string {
  return `views-${++seq}-${Date.now()}@example.com`;
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    saved_views, audit_log, api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('saved views', () => {
  it('round-trips a view: create, list, apply, rename, delete', async () => {
    const { agent } = await authedAgent(app);

    const created = await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Checkout regressions', query: 'tags=prod&q=london&q_in=input' })
      .expect(201);
    expect(created.body.name).toBe('Checkout regressions');
    expect(created.body.query).toBe('tags=prod&q=london&q_in=input');

    const listed = await agent.get('/api/v1/trace-views?surface=traces').expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(created.body.id);

    // The stored query is what the filter bar hands back, verbatim.
    const applied = await agent.get(`/api/v1/traces?${listed.body.data[0].query}`).expect(200);
    expect(applied.body).toHaveProperty('data');

    const renamed = await agent
      .patch(`/api/v1/trace-views/${created.body.id}`)
      .send({ name: 'Checkout — thumbs down' })
      .expect(200);
    expect(renamed.body.name).toBe('Checkout — thumbs down');
    expect(renamed.body.query).toBe('tags=prod&q=london&q_in=input');

    await agent.delete(`/api/v1/trace-views/${created.body.id}`).expect(204);
    const empty = await agent.get('/api/v1/trace-views?surface=traces').expect(200);
    expect(empty.body.data).toEqual([]);
  });

  it('scopes views to their surface', async () => {
    const { agent } = await authedAgent(app);
    await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Errors', query: 'status=error' })
      .expect(201);
    await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'feedback', name: 'Thumbs down', query: 'rating=down' })
      .expect(201);

    const traces = await agent.get('/api/v1/trace-views?surface=traces').expect(200);
    expect(traces.body.data.map((v: { name: string }) => v.name)).toEqual(['Errors']);

    const feedback = await agent.get('/api/v1/trace-views?surface=feedback').expect(200);
    expect(feedback.body.data.map((v: { name: string }) => v.name)).toEqual(['Thumbs down']);
  });

  it('the same name is free on a different surface but taken on the same one', async () => {
    const { agent } = await authedAgent(app);
    await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Recent', query: 'status=error' })
      .expect(201);
    await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'feedback', name: 'Recent', query: 'rating=down' })
      .expect(201);

    const clash = await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Recent', query: 'status=ok' })
      .expect(409);
    expect(clash.body.error.code).toBe('VIEW_NAME_TAKEN');
  });

  it('strips a pasted leading "?" so location.search can be sent as-is', async () => {
    const { agent } = await authedAgent(app);
    const created = await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Pasted', query: '?status=error&tags=prod' })
      .expect(201);
    expect(created.body.query).toBe('status=error&tags=prod');
  });

  it('rejects an unknown surface and an update that changes nothing', async () => {
    const { agent } = await authedAgent(app);
    await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'sessions', name: 'Nope', query: '' })
      .expect(400);
    await agent.get('/api/v1/trace-views?surface=sessions').expect(400);

    const created = await agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Real', query: 'status=ok' })
      .expect(201);
    const noop = await agent.patch(`/api/v1/trace-views/${created.body.id}`).send({}).expect(400);
    expect(noop.body.error.message).toContain('name or a query');
  });

  it('a view is invisible, unpatchable and undeletable from another team', async () => {
    const owner = await authedAgent(app);
    const created = await owner.agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Private', query: 'status=error' })
      .expect(201);

    const stranger = await authedAgent(app, { email: nextEmail() });
    const listed = await stranger.agent.get('/api/v1/trace-views?surface=traces').expect(200);
    expect(listed.body.data).toEqual([]);

    await stranger.agent
      .patch(`/api/v1/trace-views/${created.body.id}`)
      .send({ name: 'Mine now' })
      .expect(404);
    await stranger.agent.delete(`/api/v1/trace-views/${created.body.id}`).expect(404);

    // Still intact for its owner.
    const still = await owner.agent.get('/api/v1/trace-views?surface=traces').expect(200);
    expect(still.body.data[0].name).toBe('Private');
  });

  it('a teammate can rename and delete a view they did not create', async () => {
    const owner = await authedAgent(app);
    const created = await owner.agent
      .post('/api/v1/trace-views')
      .send({ surface: 'traces', name: 'Shared', query: 'status=error' })
      .expect(201);

    const teammate = await authedAgent(app, { email: nextEmail() });
    await prisma.teamMember.create({ data: { userId: teammate.userId, teamId: owner.teamId, role: 'editor' } });
    await teammate.agent.post('/api/v1/auth/switch-team').send({ teamId: owner.teamId }).expect(200);

    await teammate.agent
      .patch(`/api/v1/trace-views/${created.body.id}`)
      .send({ name: 'Shared, renamed' })
      .expect(200);
    await teammate.agent.delete(`/api/v1/trace-views/${created.body.id}`).expect(204);
  });
});
