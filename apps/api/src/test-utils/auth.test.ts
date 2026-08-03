import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { signupTestUser, authHeaders, signupTestUserWithApiKey, authedAgent } from './index';

const app = createApp();

describe('test-utils/auth (Supabase JWT helpers)', () => {
  it('signupTestUser creates a real user+team and authHeaders authorizes /auth/me', async () => {
    const ctx = await signupTestUser(app);
    expect(ctx.userId).toBeDefined();
    expect(ctx.teamId).toBeDefined();
    const dbUser = await prisma.user.findUnique({ where: { id: ctx.userId } });
    expect(dbUser?.email).toBe(ctx.email);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set(authHeaders(ctx))
      .expect(200);
    expect(me.body.user.id).toBe(ctx.userId);
    expect(me.body.team.id).toBe(ctx.teamId);
  });

  it('signupTestUserWithApiKey returns a working API key', async () => {
    const ctx = await signupTestUserWithApiKey(app);
    expect(ctx.apiKey).toMatch(/.+/);
    await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .expect(200);
  });

  it('authedAgent returns an agent that carries auth across requests', async () => {
    const { agent, userId, teamId } = await authedAgent(app);
    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.id).toBe(userId);
    expect(me.body.team.id).toBe(teamId);
    // A second request through the same agent is still authenticated.
    await agent.get('/api/v1/auth/teams').expect(200);
  });
});
