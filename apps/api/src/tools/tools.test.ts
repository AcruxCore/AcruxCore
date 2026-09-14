import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { signupTestUserWithApiKey } from '../test-utils';
import { ToolsRepository } from './tools.repository';

const app = createApp();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE tool_aliases, tool_versions, tools, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});
afterAll(async () => { await prisma.$disconnect(); });

describe('tools CRUD', () => {
  it('creates a tool and persists a DB row', async () => {
    const { apiKey, teamId, userId } = await signupTestUserWithApiKey(app);
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'get_weather', description: 'Fetch weather' })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('get_weather');
    expect(res.body.teamId).toBe(teamId);
    expect(res.body.createdBy).toBe(userId);
    const row = await prisma.tool.findUnique({ where: { id: res.body.id } });
    expect(row!.name).toBe('get_weather');
    expect(row!.deletedAt).toBeNull();
  });

  it('rejects an invalid tool name (must match provider regex)', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const res = await request(app)
      .post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'bad name!' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('lists, gets, updates, and soft-deletes a tool', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body: created } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);

    await request(app).get('/api/v1/tools').set('Authorization', `Bearer ${apiKey}`)
      .expect(200).then((r) => expect(r.body.total).toBe(1));

    await request(app).get(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`)
      .expect(200).then((r) => expect(r.body.name).toBe('get_weather'));

    await request(app).patch(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`)
      .send({ description: 'updated' }).expect(200).then((r) => expect(r.body.description).toBe('updated'));

    await request(app).delete(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`).expect(204);
    const row = await prisma.tool.findUnique({ where: { id: created.id } });
    expect(row!.deletedAt).not.toBeNull();
    await request(app).get(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${apiKey}`).expect(404);
  });

  it('isolates tools across teams', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const { body: created } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'team_a_tool' }).expect(201);
    await request(app).get(`/api/v1/tools/${created.id}`).set('Authorization', `Bearer ${b.apiKey}`).expect(404);
  });

  // A tool name is how `POST /tools/sync` and every `tool_ref` find a tool, so two
  // active tools sharing a name inside one team make resolution ambiguous. The DB
  // enforces it; this asserts the caller sees a 409 rather than a leaked 500.
  it('rejects a duplicate tool name within a team with 409', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);

    const conflict = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(409);
    expect(conflict.body.error.code).toBe('TOOL_NAME_TAKEN');
  });

  it('frees a tool name for reuse once the tool is soft-deleted', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body: first } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);
    await request(app).delete(`/api/v1/tools/${first.id}`).set('Authorization', `Bearer ${apiKey}`).expect(204);

    const { body: second } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);
    expect(second.id).not.toBe(first.id);
  });

  it('lets two different teams each have a tool with the same name', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'get_weather' }).expect(201);
    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${b.apiKey}`).send({ name: 'get_weather' }).expect(201);
  });
});

/**
 * A tool's name and description say nothing about whether the model can actually call
 * it. A shell with no committed version resolves to nothing, and the dashboard used to
 * render it identically to a working tool — so the first sign of trouble was a prompt
 * quietly running with one tool fewer than its author expected.
 *
 * These fields exist so one list request can answer "is this callable, where does it
 * run, and what is live" without a version fetch per row.
 */
describe('tool readiness on list and detail', () => {
  it('reports a version-less tool as not callable', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'shell_only' }).expect(201);

    const list = await request(app).get('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).expect(200);
    const row = list.body.data.find((t: { name: string }) => t.name === 'shell_only');
    expect(row.callable).toBe(false);
    expect(row.versionCount).toBe(0);
    expect(row.latestVersionNumber).toBeNull();
    expect(row.executorType).toBeNull();
    expect(row.aliases).toEqual([]);
  });

  it('reports the live version, executor and every alias once a version is committed', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);
    const { body: tool } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).send({ name: 'get_weather' }).expect(201);

    await request(app).post(`/api/v1/tools/${tool.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        description: 'Get the current weather for a city.',
        parametersSchema: { type: 'object', properties: { city: { type: 'string' } } },
        // A literal public IP (Cloudflare) — no live DNS lookup needed, so this stays
        // deterministic now that commit-time also runs the SSRF guard (`assertPublicUrl`).
        executor: { type: 'http', url: 'https://1.1.1.1/w', method: 'GET' },
      })
      .expect(201);

    // A second version, promoted on staging only, so production and staging differ.
    await request(app).post(`/api/v1/tools/${tool.id}/versions`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ parametersSchema: { type: 'object', properties: {} }, executor: { type: 'client' } })
      .expect(201);
    await request(app).post(`/api/v1/tools/${tool.id}/aliases/staging/promote`)
      .set('Authorization', `Bearer ${apiKey}`).send({ version_number: 2 }).expect(200);

    const list = await request(app).get('/api/v1/tools')
      .set('Authorization', `Bearer ${apiKey}`).expect(200);
    const row = list.body.data.find((t: { name: string }) => t.name === 'get_weather');
    expect(row.callable).toBe(true);
    expect(row.versionCount).toBe(2);
    expect(row.latestVersionNumber).toBe(2);
    // The executor reported is production's, because that is what an unqualified
    // `tool_ref` and a freshly connected binding both resolve to.
    expect(row.executorType).toBe('http');
    expect(row.aliases).toEqual(
      expect.arrayContaining([
        { alias: 'production', versionNumber: 1 },
        { alias: 'staging', versionNumber: 2 },
      ]),
    );

    // The single-tool fetch answers the same question, so the detail page does not
    // have to re-derive it from two more requests.
    const detail = await request(app).get(`/api/v1/tools/${tool.id}`)
      .set('Authorization', `Bearer ${apiKey}`).expect(200);
    expect(detail.body.callable).toBe(true);
    expect(detail.body.versionCount).toBe(2);
    expect(detail.body.executorType).toBe('http');
  });

  it('does not leak another team’s readiness into the list', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const { body: tool } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'shared_name' }).expect(201);
    await request(app).post(`/api/v1/tools/${tool.id}/versions`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send({ parametersSchema: { type: 'object', properties: {} }, executor: { type: 'client' } })
      .expect(201);

    await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${b.apiKey}`).send({ name: 'shared_name' }).expect(201);
    const list = await request(app).get('/api/v1/tools')
      .set('Authorization', `Bearer ${b.apiKey}`).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].callable).toBe(false);
  });

  it('never returns team A’s readiness to team B, over HTTP or straight from the repository', async () => {
    const a = await signupTestUserWithApiKey(app);
    const b = await signupTestUserWithApiKey(app);
    const { body: tool } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'team_a_only' }).expect(201);
    await request(app).post(`/api/v1/tools/${tool.id}/versions`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send({ parametersSchema: { type: 'object', properties: {} }, executor: { type: 'client' } })
      .expect(201);

    // The HTTP path was already safe: `findById`/`list` scope by team, so team B
    // never gets far enough to hit `readinessFor` with team A's tool id.
    const list = await request(app).get('/api/v1/tools')
      .set('Authorization', `Bearer ${b.apiKey}`).expect(200);
    expect(list.body.data).toEqual([]);
    await request(app).get(`/api/v1/tools/${tool.id}`)
      .set('Authorization', `Bearer ${b.apiKey}`).expect(404);

    // `readinessFor` itself is the one method in the repository that took no
    // `teamId` — call it directly, the way a future caller taking ids from a
    // request body could, and prove it refuses to answer for another team's tool.
    const repo = new ToolsRepository();
    const readiness = await repo.readinessFor([tool.id], b.teamId);
    expect(readiness.size).toBe(0);
  });

  it('stops reporting readiness for a tool once it is deleted', async () => {
    const a = await signupTestUserWithApiKey(app);
    const { body: tool } = await request(app).post('/api/v1/tools')
      .set('Authorization', `Bearer ${a.apiKey}`).send({ name: 'deleted_tool_readiness' }).expect(201);
    await request(app).post(`/api/v1/tools/${tool.id}/versions`)
      .set('Authorization', `Bearer ${a.apiKey}`)
      .send({ parametersSchema: { type: 'object', properties: {} }, executor: { type: 'client' } })
      .expect(201);

    const repo = new ToolsRepository();
    // Committed and promoted, so the tool really does have readiness to leak.
    const before = await repo.readinessFor([tool.id], a.teamId);
    expect(before.get(tool.id)?.callable).toBe(true);

    await request(app).delete(`/api/v1/tools/${tool.id}`)
      .set('Authorization', `Bearer ${a.apiKey}`).expect(204);

    // Delete is a soft delete, so the versions and aliases are still in the table.
    // Every other read in this repository filters `deletedAt`; this one must too, or a
    // caller passing ids straight from a request body still learns the tool's version
    // count and which versions its aliases point at.
    const after = await repo.readinessFor([tool.id], a.teamId);
    expect(after.size).toBe(0);
  });
});
