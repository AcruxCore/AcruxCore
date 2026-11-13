import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { signupTestUserWithApiKey } from '../../test-utils';
import { MAX_RENDER_CHARS } from './nunjucks.utils';

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A template of a few dozen bytes that renders to `8 * 2^doublings` characters. Inside the
 * isolate each doubling is one small cons-string node, so the isolate's memory cap never
 * sees the size; only the copy out to the API process would.
 */
function doubling(doublings: number): string {
  // A literal list rather than `range()`: the render route reads `range` as a missing variable.
  const list = Array.from({ length: doublings }, () => '0').join(',');
  return `{% set s = "aaaaaaaa" %}{% for i in [${list}] %}{% set s = s + s %}{% endfor %}{{ s }}`;
}

/** Signs up a team, commits `messages` as version 1 of a new prompt, returns its name + key. */
async function promptWith(messages: Array<{ role: string; content: string }>) {
  const { apiKey } = await signupTestUserWithApiKey(app);
  const name = `size-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const created = await request(app)
    .post('/api/v1/prompts')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ name })
    .expect(201);
  await request(app)
    .post(`/api/v1/prompts/${created.body.id}/versions`)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ messages })
    .expect(201);
  return { apiKey, name };
}

describe('a render is bounded in size, not only in time', () => {
  it('rejects a short template that renders past the limit with 422, not a huge 200', async () => {
    // 8 * 2^21 = 16 Mi characters from a template of about 100 bytes.
    const { apiKey, name } = await promptWith([{ role: 'user', content: doubling(21) }]);

    const res = await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: {} });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TEMPLATE_RENDER_ERROR');
    expect(res.body.error.message).toMatch(/character limit/);
  });

  it('counts the whole render, so many messages under the limit cannot add up past it', async () => {
    // Three messages of 4 Mi characters: each fits alone, together they pass 8 Mi.
    const each = doubling(19);
    const { apiKey, name } = await promptWith([
      { role: 'system', content: each },
      { role: 'user', content: each },
      { role: 'user', content: each },
    ]);

    const res = await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: {} });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TEMPLATE_RENDER_ERROR');
  });

  it('still renders a long document passed in as a variable', async () => {
    const { apiKey, name } = await promptWith([
      { role: 'system', content: 'Answer from the document.' },
      { role: 'user', content: 'Document:\n{{ doc }}\n\nQuestion: {{ q }}' },
    ]);
    const doc = 'The quick brown fox jumps over the lazy dog. '.repeat(20_000); // ~900 KB

    const res = await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { doc, q: 'What jumps?' } })
      .expect(200);

    expect(res.body.messages[1].content).toBe(`Document:\n${doc}\n\nQuestion: What jumps?`);
  });

  it('renders a loop-built template that stays under the limit', async () => {
    // 8 * 2^16 = 512 Ki characters: large, legitimate, and well inside the limit.
    const { apiKey, name } = await promptWith([{ role: 'user', content: doubling(16) }]);

    const res = await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: {} })
      .expect(200);

    expect(res.body.messages[0].content).toHaveLength(8 * 2 ** 16);
    expect(8 * 2 ** 16).toBeLessThan(MAX_RENDER_CHARS);
  });

  it('counts an inline image at its real size, not the short stand-in the sandbox sees', async () => {
    // The sandbox sees each image as a ~60-character stand-in, so 2^10 copies of a 16 KB
    // image are about 60 Ki characters inside it, and 16 Mi once the image is put back.
    const { apiKey, name } = await promptWith([
      {
        role: 'user',
        content: `{% set s = img %}{% for i in [${Array(10).fill('0').join(',')}] %}{% set s = s + s %}{% endfor %}{{ s }}`,
      },
    ]);
    const img = `data:image/png;base64,${'A'.repeat(16 * 1024)}`;

    const res = await request(app)
      .post(`/api/v1/prompts/${name}/production/render`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ variables: { img } });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TEMPLATE_RENDER_ERROR');
    expect(res.body.error.message).toMatch(/character limit/);
  });

  it('rejects an amplifying ad-hoc template on the gateway with 422 before any model lookup', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    const res = await request(app)
      .post('/api/v1/gateway/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'not-registered',
        variables: { x: 1 },
        messages: [{ role: 'user', content: doubling(21) }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TEMPLATE_RENDER_ERROR');
  });
});
