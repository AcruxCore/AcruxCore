import request from 'supertest';
import { acruxcore } from '../../src/client';
import { acruxcoreError } from '../../src/error';
import { _resetCacheForTesting } from '../../src/cache';
import prisma from '../../../../apps/api/src/shared/db/client';
import { signupTestUserWithApiKey } from '../../../../apps/api/src/test-utils/auth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../../../../apps/api/app');

const app = createApp();

/**
 * Signs up a real user and mints a personal API key.
 *
 * Delegates to apps/api's own `signupTestUserWithApiKey` rather than posting to an auth
 * endpoint directly. These suites used to hard-code `/api/v1/auth/signup`, which stopped
 * existing when auth moved to Better Auth — every test 404'd at setup. Sharing the
 * fixture means the next auth change fixes these suites for free.
 */
async function setupUserAndKey(): Promise<{ apiKey: string; cookie: string }> {
  const ctx = await signupTestUserWithApiKey(app);
  return { apiKey: ctx.apiKey, cookie: ctx.cookie };
}

beforeEach(async () => {
  _resetCacheForTesting();
  await prisma.$executeRaw`TRUNCATE TABLE prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('acruxcore SDK integration', () => {
  it('renderPrompt returns correct messages after version commit', async () => {
    const { apiKey, cookie } = await setupUserAndKey();

    const promptRes = await request(app)
      .post('/api/v1/prompts')
      .set('Cookie', cookie)
      .send({ name: `test-prompt-${Date.now()}` })
      .expect(201);
    const promptName: string = promptRes.body.name as string;
    const promptId: string = promptRes.body.id as string;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello, {{ name }}!' },
        ],
      })
      .expect(201);

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({ apiKey, baseUrl: `http://localhost:${port}/api/v1`, maxRetries: 0 });

    const { messages } = await hub.prompts.render(promptName, 'production', { name: 'Alice' });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello, Alice!' });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('renderPrompt throws MISSING_VARIABLES when required variable is not provided', async () => {
    const { apiKey, cookie } = await setupUserAndKey();

    const promptRes = await request(app)
      .post('/api/v1/prompts')
      .set('Cookie', cookie)
      .send({ name: `missing-var-test-${Date.now()}` })
      .expect(201);
    const promptId: string = promptRes.body.id as string;
    const promptName: string = promptRes.body.name as string;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({ messages: [{ role: 'user', content: 'Hello {{ name }}!' }] })
      .expect(201);

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({
      apiKey,
      baseUrl: `http://localhost:${port}/api/v1`,
      maxRetries: 0,
    });

    try {
      await hub.prompts.render(promptName, 'production', {});
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(acruxcoreError);
      expect((err as acruxcoreError).code).toBe('MISSING_VARIABLES');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('second renderPrompt call returns cached result without a second network request', async () => {
    const { apiKey, cookie } = await setupUserAndKey();

    const promptRes = await request(app)
      .post('/api/v1/prompts')
      .set('Cookie', cookie)
      .send({ name: `cache-test-${Date.now()}` })
      .expect(201);
    const promptId: string = promptRes.body.id as string;
    const promptName: string = promptRes.body.name as string;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({ messages: [{ role: 'user', content: 'Static content' }] })
      .expect(201);

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({
      apiKey,
      baseUrl: `http://localhost:${port}/api/v1`,
      cacheTtl: 60_000,
      maxRetries: 0,
    });

    const first = await hub.prompts.render(promptName, 'production');
    const second = await hub.prompts.render(promptName, 'production');

    expect(first).toEqual(second);
    expect(first.messages[0].content).toBe('Static content');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('renderPrompt renders the new variables inside the cache window instead of replaying the first render', async () => {
    const { apiKey, cookie } = await setupUserAndKey();

    const promptRes = await request(app)
      .post('/api/v1/prompts')
      .set('Cookie', cookie)
      .send({ name: `vars-cache-test-${Date.now()}` })
      .expect(201);
    const promptId: string = promptRes.body.id as string;
    const promptName: string = promptRes.body.name as string;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({ messages: [{ role: 'user', content: 'Question: {{ question }}' }] })
      .expect(201);

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    // A long TTL, so a stale-driven refetch cannot be what makes this pass.
    const hub = new acruxcore({
      apiKey,
      baseUrl: `http://localhost:${port}/api/v1`,
      cacheTtl: 600_000,
      maxRetries: 0,
    });

    const first = await hub.prompts.render(promptName, 'production', { question: 'Where is my order?' });
    const second = await hub.prompts.render(promptName, 'production', { question: 'How do I refund?' });
    const repeat = await hub.prompts.render(promptName, 'production', { question: 'Where is my order?' });

    expect(first.messages[0].content).toBe('Question: Where is my order?');
    expect(second.messages[0].content).toBe('Question: How do I refund?');
    // The first variable set is still cached, not evicted by the second.
    expect(repeat.messages[0].content).toBe('Question: Where is my order?');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('renderPrompt with cacheTtl 0 sees a newly promoted version immediately', async () => {
    const { apiKey, cookie } = await setupUserAndKey();

    const promptRes = await request(app)
      .post('/api/v1/prompts')
      .set('Cookie', cookie)
      .send({ name: `no-cache-test-${Date.now()}` })
      .expect(201);
    const promptId: string = promptRes.body.id as string;
    const promptName: string = promptRes.body.name as string;

    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({ messages: [{ role: 'user', content: 'v1 content' }] })
      .expect(201);

    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const hub = new acruxcore({
      apiKey,
      baseUrl: `http://localhost:${port}/api/v1`,
      cacheTtl: 0,
      maxRetries: 0,
    });

    const before = await hub.prompts.render(promptName, 'production');
    expect(before.messages[0].content).toBe('v1 content');

    // Commit v2 and point production at it — a caching client would still say "v1 content".
    await request(app)
      .post(`/api/v1/prompts/${promptId}/versions`)
      .set('Cookie', cookie)
      .send({ messages: [{ role: 'user', content: 'v2 content' }] })
      .expect(201);
    await request(app)
      .post(`/api/v1/prompts/${promptId}/aliases/production/promote`)
      .set('Cookie', cookie)
      .send({ version_number: 2 })
      .expect(200);

    const after = await hub.prompts.render(promptName, 'production');
    expect(after.messages[0].content).toBe('v2 content');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
