import express, { Request, Response } from 'express';
import request from 'supertest';
import prisma from '../../shared/db/client';
import { errorMiddleware } from '../../shared/middleware';
import { gatewayAuth } from './gateway-auth.middleware';
import { hashKey } from './keys.crypto';
import { resetAuthTables } from '../../test-utils';

// A tiny app that runs gatewayAuth then echoes req.gateway, so we can assert
// exactly what context each auth path produces without needing the full pipeline.
function makeProbeApp() {
  const app = express();
  app.use(express.json());
  // NOTE: no session middleware here — the virtual-key path must not need it.
  app.post('/probe', gatewayAuth, (req: Request, res: Response) => {
    res.status(200).json({ gateway: req.gateway });
  });
  app.use(errorMiddleware);
  return app;
}

async function seedTeamAndUser(email: string) {
  const user = await prisma.user.create({
    data: { email, displayName: null },
  });
  const team = await prisma.team.create({ data: { name: `${email}-team` } });
  await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, role: 'owner' } });
  return { userId: user.id, teamId: team.id };
}

describe('gatewayAuth middleware', () => {
  const app = makeProbeApp();

  // The shared reset rather than a local delete chain: this one omitted every
  // table that references `users` beyond the gateway's own, so it passed alone and
  // FK-violated in a full run as soon as an earlier suite left an `audit_log` or
  // `tools` row behind. `TRUNCATE ... CASCADE` reaches the dependants on its own.
  beforeEach(resetAuthTables);

  afterAll(async () => {
    await resetAuthTables();
    await prisma.$disconnect();
  });

  it('virtual-key path: resolves an active key into req.gateway (no session needed)', async () => {
    const { userId, teamId } = await seedTeamAndUser('vk@test.com');
    const token = 'agh_sk_probe_token_1234';
    await prisma.virtualKey.create({
      data: {
        teamId,
        name: 'probe',
        keyHash: hashKey(token),
        keyLastFour: token.slice(-4),
        allowedModels: ['gpt-4o-mini'],
        allowedProviders: [],
        maxRpm: 60,
        maxTpm: null,
        cacheTtlSeconds: 300,
        createdBy: userId,
      },
    });

    const res = await request(app)
      .post('/probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.gateway.teamId).toBe(teamId);
    expect(res.body.gateway.virtualKeyId).toBeDefined();
    expect(res.body.gateway.allowedModels).toEqual(['gpt-4o-mini']);
    expect(res.body.gateway.allowedProviders).toBeNull(); // [] mapped to null
    expect(res.body.gateway.maxRpm).toBe(60);
    expect(res.body.gateway.cacheTtlSeconds).toBe(300);
  });

  it('virtual-key path: unknown/revoked token → 401 INVALID_KEY', async () => {
    const res = await request(app)
      .post('/probe')
      .set('Authorization', 'Bearer agh_sk_does_not_exist')
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_KEY');
  });

  it('fallback path: non-agh token with no session → 401 (delegated to requireAnyAuth)', async () => {
    // A random Bearer that is not agh_sk_ falls through to requireApiKey → 401.
    await request(app)
      .post('/probe')
      .set('Authorization', 'Bearer some-personal-key')
      .expect(401);
  });
});
