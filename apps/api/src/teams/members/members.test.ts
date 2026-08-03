import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

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

describe('GET /api/v1/teams/:id/members', () => {
  it('owner can list members', async () => {
    const owner = await authedAgent(app, { email: 'owner@members.test' });
    const res = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/members`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].email).toBe('owner@members.test');
    expect(res.body[0].role).toBe('owner');
  });

  it('returns 401 when unauthenticated', async () => {
    const owner = await authedAgent(app, { email: 'owner2@members.test' });
    await request(app)
      .get(`/api/v1/teams/${owner.teamId}/members`)
      .expect(401);
  });

  it('returns 403 when an authenticated user who is not a member of the target team requests its member list', async () => {
    const ownerA = await authedAgent(app, { email: 'owner-a@idor.test' });
    const ownerB = await authedAgent(app, { email: 'owner-b@idor.test' });

    // ownerA is authenticated, but has no membership in ownerB's team.
    await ownerA.agent
      .get(`/api/v1/teams/${ownerB.teamId}/members`)
      .expect(403);
  });

  it('a non-owner member (viewer) of the target team can still list its members', async () => {
    const owner = await authedAgent(app, { email: 'owner@viewerlist.test' });
    const viewer = await authedAgent(app, { email: 'viewer@viewerlist.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: viewer.userId, role: 'viewer' },
    });

    const res = await viewer.agent
      .get(`/api/v1/teams/${owner.teamId}/members`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });
});

describe('PATCH /api/v1/teams/:id/members/:userId/roles', () => {
  it('owner can update a member role', async () => {
    const owner = await authedAgent(app, { email: 'owner@roles.test' });
    const member = await authedAgent(app, { email: 'member@roles.test' });

    // Add member to owner's team directly
    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: member.userId, role: 'viewer' },
    });

    const res = await owner.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${member.userId}/roles`)
      .send({ role: 'editor' })
      .expect(200);

    expect(res.body.role).toBe('editor');
  });

  it('returns 403 when editor tries to update roles', async () => {
    const owner = await authedAgent(app, { email: 'owner@roles2.test' });
    const editor = await authedAgent(app, { email: 'editor@roles2.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: editor.userId, role: 'editor' },
    });

    const victim = await authedAgent(app, { email: 'victim@roles2.test' });
    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: victim.userId, role: 'viewer' },
    });

    await editor.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${victim.userId}/roles`)
      .send({ role: 'admin' })
      .expect(403);
  });

  it('returns 404 when target user is not a member', async () => {
    const owner = await authedAgent(app, { email: 'owner@roles3.test' });
    const outsider = await authedAgent(app, { email: 'outsider@roles3.test' });

    await owner.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${outsider.userId}/roles`)
      .send({ role: 'editor' })
      .expect(404);
  });

  // The path keeps its plural `/roles` segment, so the only signal a caller gets
  // that the body changed is this 400 — it must not be silently accepted.
  it('returns 400 for the old array body `{ roles: [...] }` and leaves the role untouched', async () => {
    const owner = await authedAgent(app, { email: 'owner@roles4.test' });
    const member = await authedAgent(app, { email: 'member@roles4.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: member.userId, role: 'viewer' },
    });

    await owner.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${member.userId}/roles`)
      .send({ roles: ['editor'] })
      .expect(400);

    const row = await prisma.teamMember.findFirst({
      where: { teamId: owner.teamId, userId: member.userId },
    });
    expect(row?.role).toBe('viewer');
  });

  it('returns 403 LAST_OWNER when an admin tries to demote the sole owner via updateRoles', async () => {
    const owner = await authedAgent(app, { email: 'owner@lastownerroles.test' });
    const admin = await authedAgent(app, { email: 'admin@lastownerroles.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: admin.userId, role: 'admin' },
    });

    const res = await admin.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${owner.userId}/roles`)
      .send({ role: 'viewer' })
      .expect(403);

    expect(res.body.error.code).toBe('LAST_OWNER');

    // The owner's role must be unchanged in the DB.
    const ownerMember = await prisma.teamMember.findFirst({
      where: { teamId: owner.teamId, userId: owner.userId },
    });
    expect(ownerMember?.role).toBe('owner');
  });

  it('allows demoting an owner via updateRoles when a second owner remains', async () => {
    const owner = await authedAgent(app, { email: 'owner@twoowners.test' });
    const secondOwner = await authedAgent(app, { email: 'second-owner@twoowners.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: secondOwner.userId, role: 'owner' },
    });

    const res = await owner.agent
      .patch(`/api/v1/teams/${owner.teamId}/members/${secondOwner.userId}/roles`)
      .send({ role: 'viewer' })
      .expect(200);

    expect(res.body.role).toBe('viewer');
  });
});

describe('DELETE /api/v1/teams/:id/members/:userId', () => {
  it('owner can remove a member', async () => {
    const owner = await authedAgent(app, { email: 'owner@remove.test' });
    const member = await authedAgent(app, { email: 'member@remove.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: member.userId, role: 'viewer' },
    });

    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/members/${member.userId}`)
      .expect(204);

    // Verify the member list no longer contains the removed user
    const listRes = await owner.agent
      .get(`/api/v1/teams/${owner.teamId}/members`)
      .expect(200);

    const emails = (listRes.body as Array<{ email: string }>).map((m) => m.email);
    expect(emails).not.toContain('member@remove.test');
  });

  it('cannot remove the last owner', async () => {
    const owner = await authedAgent(app, { email: 'owner@lastowner.test' });

    const res = await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/members/${owner.userId}`)
      .expect(403);

    expect(res.body.error.code).toBe('LAST_OWNER');
  });

  it('returns 404 when member not found', async () => {
    const owner = await authedAgent(app, { email: 'owner@removenotfound.test' });
    const outsider = await authedAgent(app, { email: 'outsider@removenotfound.test' });

    await owner.agent
      .delete(`/api/v1/teams/${owner.teamId}/members/${outsider.userId}`)
      .expect(404);
  });
});

describe('concurrent last-owner protection (race condition regression)', () => {
  it('cannot demote one owner and remove the other at the same time and end up with zero owners', async () => {
    // Reproduces the exact race the previous "last owner" guard missed: the
    // guard read the owner count in a standalone query, separate from the
    // write, so two concurrent requests each targeting a DIFFERENT owner of
    // the same team could both observe "2 owners, not sole" before either
    // write committed, and both proceed — leaving the team with zero owners.
    const owner = await authedAgent(app, { email: 'owner@raceowners.test' });
    const secondOwner = await authedAgent(app, { email: 'second-owner@raceowners.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: secondOwner.userId, role: 'owner' },
    });

    // Concurrently: demote the first owner (via updateRoles) and remove the
    // second owner (via remove) — the same mixed scenario the bug report describes.
    const [demoteRes, removeRes] = await Promise.all([
      owner.agent
        .patch(`/api/v1/teams/${owner.teamId}/members/${owner.userId}/roles`)
        .send({ role: 'viewer' }),
      owner.agent.delete(`/api/v1/teams/${owner.teamId}/members/${secondOwner.userId}`),
    ]);

    // At most one of the two owner-modifying operations may succeed. If both
    // succeeded, the team would end up with zero owners.
    const succeeded = [demoteRes, removeRes].filter((r) => r.status < 400);
    expect(succeeded.length).toBe(1);

    const failed = [demoteRes, removeRes].find((r) => r.status >= 400);
    expect(failed?.status).toBe(403);
    expect(failed?.body.error.code).toBe('LAST_OWNER');

    // The team must still have at least one owner in the DB.
    const owners = await prisma.teamMember.findMany({
      where: { teamId: owner.teamId, role: 'owner' },
    });
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  it('cannot remove both owners of a team at the same time', async () => {
    const owner = await authedAgent(app, { email: 'owner@raceremove.test' });
    const secondOwner = await authedAgent(app, { email: 'second-owner@raceremove.test' });

    await prisma.teamMember.create({
      data: { teamId: owner.teamId, userId: secondOwner.userId, role: 'owner' },
    });

    // Concurrently: remove each owner via a separate request targeting the other.
    const [res1, res2] = await Promise.all([
      owner.agent.delete(`/api/v1/teams/${owner.teamId}/members/${owner.userId}`),
      owner.agent.delete(`/api/v1/teams/${owner.teamId}/members/${secondOwner.userId}`),
    ]);

    const succeeded = [res1, res2].filter((r) => r.status < 400);
    expect(succeeded.length).toBe(1);

    const failed = [res1, res2].find((r) => r.status >= 400);
    expect(failed?.status).toBe(403);
    expect(failed?.body.error.code).toBe('LAST_OWNER');

    const owners = await prisma.teamMember.findMany({
      where: { teamId: owner.teamId, role: 'owner' },
    });
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });
});
