import { randomUUID } from 'node:crypto';
import express, { Request, Response } from 'express';
import request from 'supertest';
import prisma from '../db/client';
import { errorMiddleware } from './error.middleware';
import { requireAnyAuthOrVirtualKey } from './require-any-auth-or-virtual-key.middleware';
import { hashKey } from '../../gateway/keys/keys.crypto';
import { hashKey as hashApiKey } from '../../api-keys/api-keys.crypto';
import { createApp } from '../../../app';
import { authHeaders, resetAuthTables, signupTestUser } from '../../test-utils';

// A tiny app that runs requireAnyAuthOrVirtualKey then echoes what it attached
// to req, so we can assert exactly what each auth path produces. Callers present
// a virtual key or a personal API key in the Authorization header, or a browser
// session cookie.
//
// The probe app does not mount Better Auth's endpoints, so a session for the
// cookie case is created against the real app (`realApp` below). Both share this
// process's single Better Auth instance and the same database, so a cookie issued
// by one validates on the other.
function makeProbeApp() {
  const app = express();
  app.use(express.json());
  app.post('/probe', requireAnyAuthOrVirtualKey, (req: Request, res: Response) => {
    res.status(200).json({ teamId: req.teamId, userId: req.user?.id });
  });
  app.use(errorMiddleware);
  return app;
}

const realApp = createApp();

async function seedTeamAndUser(email: string, role: 'owner' | 'viewer') {
  const user = await prisma.user.create({
    data: { email, displayName: null },
  });
  const team = await prisma.team.create({ data: { name: `${email}-team` } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, role } });
  return { userId: user.id, teamId: team.id };
}

/** A real signed-up user placed in their own team with the given role. */
async function seedSessionUser(email: string, role: 'owner' | 'viewer') {
  const ctx = await signupTestUser(realApp, { email });
  if (role !== 'owner') {
    await prisma.teamMember.update({
      where: { userId_teamId: { userId: ctx.userId, teamId: ctx.teamId } },
      data: { role },
    });
  }
  return ctx;
}

describe('requireAnyAuthOrVirtualKey middleware', () => {
  const app = makeProbeApp();

  // `resetAuthTables()` rather than a delete chain: the chain omitted `audit_log`,
  // whose `actor_id` references `users`, so this suite passed alone and then
  // FK-violated on its very first `beforeEach` whenever an earlier suite left an
  // audit row behind. Growing the chain one constraint at a time is a losing
  // game; the TRUNCATE also reaches `virtual_keys` by cascading from `teams`.
  beforeEach(resetAuthTables);

  afterAll(async () => {
    await resetAuthTables();
    await prisma.$disconnect();
  });

  it('virtual-key path: resolves an active key and sets req.teamId (no user auth needed)', async () => {
    const { userId, teamId } = await seedTeamAndUser('vk@test.com', 'owner');
    const token = 'agh_sk_probe_token_1234';
    await prisma.virtualKey.create({
      data: {
        teamId,
        name: 'probe',
        keyHash: hashKey(token),
        keyLastFour: token.slice(-4),
        allowedModels: [],
        allowedProviders: [],
        maxRpm: null,
        maxTpm: null,
        cacheTtlSeconds: null,
        createdBy: userId,
      },
    });

    const res = await request(app)
      .post('/probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.teamId).toBe(teamId);
  });

  it('virtual-key path: unknown/revoked token → 401 INVALID_KEY', async () => {
    const res = await request(app)
      .post('/probe')
      .set('Authorization', 'Bearer agh_sk_does_not_exist')
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_KEY');
  });

  it('personal-key path: a VIEWER role is accepted (no role gate) and sets req.teamId', async () => {
    const { userId, teamId } = await seedTeamAndUser('viewer@test.com', 'viewer');
    // Deliberately not an acx_sk_ token: the middleware hashes whatever is
    // presented and never validates the prefix.
    const token = 'personal-viewer-key';
    await prisma.apiKey.create({
      data: {
        userId,
        teamId,
        keyHash: hashApiKey(token),
        keyLastFour: token.slice(-4),
        scope: 'personal',
      },
    });

    const res = await request(app)
      .post('/probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.teamId).toBe(teamId);
    expect(res.body.userId).toBe(userId);
  });

  it('session path: a VIEWER role is accepted (no role gate) and sets req.teamId', async () => {
    const ctx = await seedSessionUser('session-viewer@test.com', 'viewer');

    const res = await request(app).post('/probe').set(authHeaders(ctx)).expect(200);

    expect(res.body.teamId).toBe(ctx.teamId);
    expect(res.body.userId).toBe(ctx.userId);
  });

  it('fallback path: no Authorization header → 401', async () => {
    await request(app).post('/probe').expect(401);
  });

  it('fallback path: non-agh token with no matching key → 401', async () => {
    await request(app)
      .post('/probe')
      .set('Authorization', 'Bearer some-personal-key-that-does-not-exist')
      .expect(401);
  });
});
