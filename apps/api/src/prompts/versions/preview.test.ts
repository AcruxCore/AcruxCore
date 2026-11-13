import { randomUUID } from 'node:crypto';
import * as nunjucks from 'nunjucks';
import request from 'supertest';
import { createApp } from '../../../app';
import { addUserToTeam, authedAgent, authHeaders, type AuthedAgent } from '../../test-utils';

/**
 * `POST /prompts/:id/preview` renders an unsaved draft for the dashboard's Preview tab.
 *
 * The Preview used to run nunjucks in the browser. nunjucks compiles a template into a
 * JavaScript function and walks the prototype chain on attribute access, so a stored
 * template such as `{{ ''.constructor.constructor('…')() }}` ran its author's code in
 * the session of whoever opened the tab. The draft now renders here, in the same
 * isolated-vm sandbox every other render uses, and the page only shows text.
 */
const app = createApp();

/** A signed-in team owner with one prompt. */
async function ownerWithPrompt(): Promise<AuthedAgent & { promptId: string }> {
  const owner = await authedAgent(app);
  const prompt = await owner.agent
    .post('/api/v1/prompts')
    .send({ name: `preview-${randomUUID()}` })
    .expect(201);
  return { ...owner, promptId: prompt.body.id as string };
}

/**
 * The engine the browser Preview used to run, configured the way it was
 * (`apps/web/src/lib/template.ts` before this change). The server must render
 * every ordinary template to the same text, so moving the render is invisible.
 */
const OLD_CLIENT_ENV = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });

describe('POST /api/v1/prompts/:id/preview', () => {
  it('requires a signed-in caller', async () => {
    const { promptId } = await ownerWithPrompt();

    await request(app)
      .post(`/api/v1/prompts/${promptId}/preview`)
      .send({ messages: [{ role: 'user', content: 'Hi {{ name }}' }], variables: {} })
      .expect(401);
  });

  it('lets a viewer preview, since every member can open the Preview tab', async () => {
    const owner = await ownerWithPrompt();
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');

    const res = await request(app)
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .set(authHeaders(viewer))
      .send({ messages: [{ role: 'user', content: 'Hi {{ name }}' }], variables: { name: 'Ada' } })
      .expect(200);

    expect(res.body).toEqual({ messages: [{ role: 'user', content: 'Hi Ada' }] });
  });

  it("answers 404 for another team's prompt, as for one that never existed", async () => {
    const owner = await ownerWithPrompt();
    const outsider = await authedAgent(app);
    const body = { messages: [{ role: 'user', content: 'Hi {{ name }}' }], variables: {} };

    const foreign = await outsider.agent.post(`/api/v1/prompts/${owner.promptId}/preview`).send(body).expect(404);
    const missing = await outsider.agent.post(`/api/v1/prompts/${randomUUID()}/preview`).send(body).expect(404);

    expect(foreign.body).toEqual(missing.body);
  });

  it('runs a Function-constructor gadget only inside the sandbox, where it reaches nothing', async () => {
    const owner = await ownerWithPrompt();
    const marker = `__acxPreviewGadget_${randomUUID().replace(/-/g, '')}`;

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({
        messages: [
          { role: 'system', content: `{{ ''.constructor.constructor('globalThis.${marker} = true; return 42')() }}` },
          { role: 'user', content: "{{ ''.constructor.constructor('return typeof process + \",\" + typeof require')() }}" },
        ],
        variables: {},
      })
      .expect(200);

    // The code ran in a throwaway isolate: it set nothing in this process, and the
    // isolate has no `process` or `require` to reach the host, the network or the disk.
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(res.body.messages).toEqual([
      { role: 'system', content: '42' },
      { role: 'user', content: 'undefined,undefined' },
    ]);
  });

  it('renders ordinary templates exactly as the old in-browser Preview did', async () => {
    const owner = await ownerWithPrompt();
    const variables = {
      name: 'Ada',
      tier: 'gold',
      items: ['a', 'b', 'c'],
      user: { name: 'Grace', langs: ['en', 'fr'] },
      empty: [],
      note: '',
    };
    const templates = [
      'Hello {{ name }}, missing: [{{ nobody }}].',
      '{% if tier == "gold" %}Priority{% elif tier == "silver" %}Normal{% else %}Low{% endif %} support.',
      '{% for x in items %}{{ loop.index }}={{ x | upper }}{% if not loop.last %}, {% endif %}{% endfor %}',
      '{% for x in empty %}{{ x }}{% else %}nothing{% endfor %}',
      'Hello {{ name }}. {% for name in items %}{{ name }}{% endfor %} Bye {{ name }}.',
      '{{ user.name }} speaks {{ user.langs | join(" and ") }}; {{ items | length }} items; {{ nobody | default("n/a") }}',
      '{% set greeting = "Hi" %}{{ greeting }} {{ name | lower | capitalize }}{# a comment #}',
      '{{ "  trimmed  " | trim }}|{{ name | replace("A", "E") }}|{{ 3 * 4 }}|{{ note or "none" }}',
      'Plain text with no tags.',
      '{% raw %}{{ not rendered }}{% endraw %}',
    ];

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({ messages: templates.map((content) => ({ role: 'user', content })), variables })
      .expect(200);

    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual(
      templates.map((t) => OLD_CLIENT_ENV.renderString(t, variables)),
    );
  });

  it('renders each message as its own template, so a set in one does not leak into another', async () => {
    const owner = await ownerWithPrompt();

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({
        messages: [
          { role: 'system', content: 'Support for {{ company }}.' },
          { role: 'user', content: '{% set company = "OtherCo" %}Ticket for {{ company }}.' },
        ],
        variables: { company: 'Acme' },
      })
      .expect(200);

    expect(res.body.messages).toEqual([
      { role: 'system', content: 'Support for Acme.' },
      { role: 'user', content: 'Ticket for OtherCo.' },
    ]);
  });

  it('renders the text and image link of a message with parts, keeping the detail field', async () => {
    const owner = await ownerWithPrompt();

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this {{ kind }}.' },
              { type: 'image_url', image_url: { url: '{{ receipt_url }}', detail: 'high' } },
            ],
          },
        ],
        variables: { kind: 'receipt', receipt_url: 'https://x.test/a.png' },
      })
      .expect(200);

    expect(res.body.messages[0].content).toEqual([
      { type: 'text', text: 'Read this receipt.' },
      { type: 'image_url', image_url: { url: 'https://x.test/a.png', detail: 'high' } },
    ]);
  });

  it('accepts a half-written draft: an empty message renders as empty', async () => {
    const owner = await ownerWithPrompt();

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({ messages: [{ role: 'system', content: '' }, { role: 'user', content: 'Hi' }] })
      .expect(200);

    expect(res.body.messages).toEqual([
      { role: 'system', content: '' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('answers 422 with the parser message for a template that does not parse', async () => {
    const owner = await ownerWithPrompt();

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({ messages: [{ role: 'user', content: '{% for x in %}' }], variables: {} })
      .expect(422);

    expect(res.body.error.code).toBe('TEMPLATE_RENDER_ERROR');
    expect(res.body.error.message).toMatch(/Template render error/);
  });

  it('stops a runaway loop at the sandbox timeout instead of hanging', async () => {
    const owner = await ownerWithPrompt();
    const started = Date.now();

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({
        messages: [{ role: 'user', content: '{% for i in range(0, 100000000) %}{{ i }}{% endfor %}' }],
        variables: {},
      })
      .expect(422);

    expect(res.body.error.code).toBe('TEMPLATE_RENDER_ERROR');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a draft with more templates to render than any real prompt has', async () => {
    const owner = await ownerWithPrompt();
    const messages = Array.from({ length: 101 }, (_, i) => ({ role: 'user', content: `{{ v${i} }}` }));

    const res = await owner.agent
      .post(`/api/v1/prompts/${owner.promptId}/preview`)
      .send({ messages, variables: {} })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a body without messages', async () => {
    const owner = await ownerWithPrompt();

    await owner.agent.post(`/api/v1/prompts/${owner.promptId}/preview`).send({ variables: {} }).expect(400);
    await owner.agent.post(`/api/v1/prompts/${owner.promptId}/preview`).send({ messages: [] }).expect(400);
  });

  it("limits how many previews one team renders at once, without slowing another team's", async () => {
    const owner = await ownerWithPrompt();
    const other = await ownerWithPrompt();
    // Each template loops long enough to keep the sandbox busy for a while, inside its
    // per-template time limit, so the requests overlap.
    const list = Array.from({ length: 250 }, (_, i) => i).join(',');
    const busy = `{% for a in [${list}] %}{% for b in [${list}] %}{% endfor %}{% endfor %}x`;
    const draft = { messages: Array.from({ length: 8 }, () => ({ role: 'user', content: busy })), variables: {} };
    const preview = (who: AuthedAgent & { promptId: string }) =>
      who.agent.post(`/api/v1/prompts/${who.promptId}/preview`).send(draft).then((r) => r);

    const burst = await Promise.all([
      preview(owner),
      preview(owner),
      preview(owner),
      preview(owner),
      preview(owner),
      preview(other),
    ]);
    const mine = burst.slice(0, 5);

    expect(mine.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    expect(mine.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    expect(mine.find((r) => r.status === 429)!.body.error.code).toBe('RATE_LIMITED');
    expect(mine.find((r) => r.status === 429)!.headers['retry-after']).toBe('1');
    expect(burst[5]!.status).toBe(200);
  }, 60_000);
});
