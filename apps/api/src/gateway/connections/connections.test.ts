// Must be set BEFORE anything that may read the env at import time.
process.env.GATEWAY_ENCRYPTION_KEY =
  process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { decryptSecret } from './crypto';
import { authHeaders, resetAuthTables, signupTestUser } from '../../test-utils';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const app = createApp();

async function truncateTables(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

/** Rewrites the caller's role in their own team so RBAC tests can act as editor/viewer. */
async function setRole(userId: string, teamId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') {
  await prisma.teamMember.update({ where: { userId_teamId: { userId, teamId } }, data: { role } });
}

const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwxyzAB12';

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

// ── POST /gateway/connections ───────────────────────────────────────────────

describe('POST /api/v1/gateway/connections', () => {
  it('creates a connection, returns it masked (keyLastFour, no apiKey)', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod OpenAI', apiKey: OPENAI_KEY, config: {} })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.provider).toBe('openai');
    expect(res.body.label).toBe('Prod OpenAI');
    expect(res.body.keyLastFour).toBe('AB12');
    expect(res.body.apiKey).toBeUndefined();
    expect(res.body.secretCiphertext).toBeUndefined();
    expect(res.body.createdBy).toBeDefined();
  });

  it('stores the key encrypted: DB bytes contain no plaintext and decrypt to the original', async () => {
    const ctx = await signupTestUser(app);

    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod', apiKey: OPENAI_KEY })
      .expect(201);

    const row = await prisma.providerConnection.findUnique({ where: { id: res.body.id } });
    expect(row).not.toBeNull();
    // The ciphertext must not contain the plaintext key.
    expect(Buffer.from(row!.secretCiphertext).toString('utf8')).not.toContain(OPENAI_KEY);
    expect(Buffer.from(row!.secretCiphertext).toString('utf8')).not.toContain('sk-abcdef');
    // But it decrypts back to the exact original.
    expect(decryptSecret(row!.secretCiphertext)).toBe(OPENAI_KEY);
  });

  it('emits a provider_connection_created audit event', async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod', apiKey: OPENAI_KEY })
      .expect(201);

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_created' },
    });
    expect(events).toHaveLength(1);
    expect((events[0].metadata as Record<string, unknown>).connectionId).toBe(res.body.id);
  });

  it('rejects openai_compatible without config.base_url (400)', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai_compatible', label: 'Groq', apiKey: 'gsk_123', config: {} })
      .expect(400);
  });

  it('accepts openai_compatible with a valid base_url (201)', async () => {
    const ctx = await signupTestUser(app);
    const res = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({
        provider: 'openai_compatible',
        label: 'Groq',
        apiKey: 'gsk_1234',
        config: { base_url: 'https://api.groq.com/openai/v1' },
      })
      .expect(201);
    expect(res.body.config.base_url).toBe('https://api.groq.com/openai/v1');
  });

  it('returns 403 when an editor tries to create a connection', async () => {
    const ctx = await signupTestUser(app);
    await setRole(ctx.userId, ctx.teamId, 'editor');

    await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Nope', apiKey: OPENAI_KEY })
      .expect(403);
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .post('/api/v1/gateway/connections')
      .send({ provider: 'openai', label: 'x', apiKey: OPENAI_KEY })
      .expect(401);
  });
});

// ── GET /gateway/connections ────────────────────────────────────────────────

describe('GET /api/v1/gateway/connections', () => {
  it('lists connections masked (never the key); viewer can list (200)', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Prod', apiKey: OPENAI_KEY })
      .expect(201);

    // Demote to viewer — reads must still work.
    await setRole(ctx.userId, ctx.teamId, 'viewer');

    const res = await request(app)
      .get('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].keyLastFour).toBe('AB12');
    expect(res.body[0].apiKey).toBeUndefined();
    expect(res.body[0].secretCiphertext).toBeUndefined();
  });
});

// ── GET /gateway/connections/:id ──────────────────────────────────────────────

describe('GET /api/v1/gateway/connections/:id', () => {
  it("returns 404 for another team's connection (isolation)", async () => {
    const alice = await signupTestUser(app);
    const bob = await signupTestUser(app);

    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(alice))
      .send({ provider: 'openai', label: 'Alice key', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .get(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(bob))
      .expect(404);
  });
});

// ── PATCH /gateway/connections/:id ────────────────────────────────────────────

describe('PATCH /api/v1/gateway/connections/:id', () => {
  it('updates the label (200)', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Old label', apiKey: OPENAI_KEY })
      .expect(201);

    const res = await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ label: 'New label' })
      .expect(200);

    expect(res.body.label).toBe('New label');
  });

  it('rotating the key changes keyLastFour and re-encrypts to the new key', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Rotate me', apiKey: OPENAI_KEY })
      .expect(201);

    const newKey = 'sk-zzzzzzzzzzzzzzzzzzzzzzzzzz9999';
    const res = await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ apiKey: newKey })
      .expect(200);

    expect(res.body.keyLastFour).toBe('9999');

    const row = await prisma.providerConnection.findUnique({ where: { id: created.body.id } });
    expect(decryptSecret(row!.secretCiphertext)).toBe(newKey);
  });

  it('emits a provider_connection_updated audit event with rotatedKey: true when the key is rotated', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Rotate me', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ apiKey: 'sk-zzzzzzzzzzzzzzzzzzzzzzzzzz9999' })
      .expect(200);

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_updated' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(ctx.userId);
    const metadata = events[0].metadata as Record<string, unknown>;
    expect(metadata.connectionId).toBe(created.body.id);
    expect(metadata.rotatedKey).toBe(true);
  });

  it('emits a provider_connection_updated audit event with rotatedKey: false for a label-only update', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Old label', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ label: 'New label' })
      .expect(200);

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_updated' },
    });
    expect(events).toHaveLength(1);
    const metadata = events[0].metadata as Record<string, unknown>;
    expect(metadata.rotatedKey).toBe(false);
  });
});

// ── DELETE /gateway/connections/:id ───────────────────────────────────────────

describe('DELETE /api/v1/gateway/connections/:id', () => {
  it('deletes (204), emits audit, and a subsequent GET is 404', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'Delete me', apiKey: OPENAI_KEY })
      .expect(201);

    await request(app)
      .delete(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(204);

    await request(app)
      .get(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(404);

    const gone = await prisma.providerConnection.findUnique({ where: { id: created.body.id } });
    expect(gone).toBeNull();

    const events = await prisma.auditLog.findMany({
      where: { teamId: ctx.teamId, event: 'provider_connection_deleted' },
    });
    expect(events).toHaveLength(1);
  });
});

describe('editing a connection keeps its other settings (issue #489)', () => {
  it('merges config instead of replacing it', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({
        provider: 'openai_compatible',
        label: 'Self-hosted',
        apiKey: 'sk-proof-abcdAB12',
        config: { base_url: 'https://api.groq.com/openai/v1' },
      })
      .expect(201);

    // A PATCH naming only an unrelated key used to replace the whole object, so
    // the base_url an openai_compatible connection requires disappeared and every
    // model on that credential started failing with a non-retriable error that
    // pointed nowhere near this edit.
    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ config: { organization: 'acme' } })
      .expect(200);

    const after = await request(app)
      .get(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(200);
    expect(after.body.config).toEqual({
      base_url: 'https://api.groq.com/openai/v1',
      organization: 'acme',
    });
  }, 60000);

  it('lets an explicit new value overwrite the old one', async () => {
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({
        provider: 'openai_compatible', label: 'Self-hosted', apiKey: 'sk-proof-abcdAB12',
        config: { base_url: 'https://api.groq.com/openai/v1' },
      })
      .expect(201);
    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ config: { base_url: 'https://openrouter.ai/api/v1' } })
      .expect(200);
    const after = await request(app)
      .get(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(200);
    expect(after.body.config.base_url).toBe('https://openrouter.ai/api/v1');
  }, 60000);

  it('removes a config key sent as null, and leaves the rest', async () => {
    // Merge semantics need a way to say "take this away". Without one, a connection
    // pointing at a decommissioned host can never be corrected: `{}` changes nothing,
    // an empty string fails validation, and delete-and-recreate is refused with 409
    // while any model still binds the credential.
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({
        provider: 'openai_compatible',
        label: 'Self-hosted',
        apiKey: 'sk-proof-abcdAB12',
        config: { base_url: 'https://api.groq.com/openai/v1', organization: 'acme' },
      })
      .expect(201);

    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ config: { base_url: null } })
      .expect(200);

    const after = await request(app)
      .get(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .expect(200);
    expect(after.body.config).toEqual({ organization: 'acme' });
  }, 60000);

  it('still rejects a base_url that is present but unusable', async () => {
    // The null case must not become a hole in the SSRF check: anything that is not
    // a removal is still validated exactly as before.
    const ctx = await signupTestUser(app);
    const created = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({
        provider: 'openai_compatible', label: 'Self-hosted', apiKey: 'sk-proof-abcdAB12',
        config: { base_url: 'https://api.groq.com/openai/v1' },
      })
      .expect(201);

    await request(app)
      .patch(`/api/v1/gateway/connections/${created.body.id}`)
      .set(authHeaders(ctx))
      .send({ config: { base_url: 'http://169.254.169.254/latest' } })
      .expect(400);
  }, 60000);
});

// ── Extra provider headers (issue #790) ─────────────────────────────────────

describe('openai_compatible connections send config.headers to the provider (issue #790)', () => {
  const BASE_URL = 'https://api.example.com/v1';
  const CANNED = {
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'go-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };

  // Not async: returning supertest's Test keeps `.expect` at the call site.
  function createCompatible(ctx: Awaited<ReturnType<typeof signupTestUser>>, config: Record<string, unknown>): request.Test {
    return request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai_compatible', label: 'OpenCode Go', apiKey: OPENAI_KEY, config: { base_url: BASE_URL, ...config } });
  }

  it('a gateway call (plain and streamed) carries the connection headers; Authorization stays the key', async () => {
    // A stand-in for OpenCode Go: it refuses any call without `x-opencode-session`.
    const seen: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push(req.headers);
        if (!req.headers['x-opencode-session']) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Request is missing x-opencode-session' } }));
          return;
        }
        if (JSON.parse(raw).stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CANNED));
      });
    });
    allowLoopbackForTests();
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    try {
      const baseUrl = `http://localhost:${(upstream.address() as AddressInfo).port}/v1`;
      const ctx = await signupTestUser(app);
      const conn = await request(app)
        .post('/api/v1/gateway/connections')
        .set(authHeaders(ctx))
        .send({
          provider: 'openai_compatible',
          label: 'OpenCode Go',
          apiKey: OPENAI_KEY,
          config: { base_url: baseUrl, headers: { 'x-opencode-session': 'acx-gateway' } },
        })
        .expect(201);
      expect(conn.body.config.headers).toEqual({ 'x-opencode-session': 'acx-gateway' });
      await request(app)
        .post('/api/v1/gateway/models')
        .set(authHeaders(ctx))
        .send({ publicName: 'go-model', upstreamModel: 'go-model', credentialId: conn.body.id })
        .expect(201);

      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set(authHeaders(ctx))
        .send({ model: 'go-model', messages: [{ role: 'user', content: 'hi' }] })
        .expect(200);
      const streamed = await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set(authHeaders(ctx))
        .send({ model: 'go-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
        .expect(200);
      expect(streamed.text).toContain('[DONE]');

      expect(seen).toHaveLength(2);
      for (const h of seen) {
        expect(h['x-opencode-session']).toBe('acx-gateway');
        expect(h.authorization).toBe(`Bearer ${OPENAI_KEY}`);
      }
    } finally {
      resetSsrfAllowlist();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it.each([['Authorization'], ['host'], ['Content-Type'], ['Cookie'], ['proxy-authorization'], ['x-api-key']])(
    'refuses %s, which carries auth or is set by the gateway itself',
    async (name) => {
      const ctx = await signupTestUser(app);
      const res = await createCompatible(ctx, { headers: { [name]: 'x' } }).expect(400);
      expect(JSON.stringify(res.body)).toContain('headers');
    },
  );

  it.each([['x-goog-api-key'], ['X-Auth-Token'], ['x-access-token'], ['ocp-apim-subscription-key'], ['x-client-secret']])(
    'refuses %s, whose name says it carries a credential',
    async (name) => {
      const ctx = await signupTestUser(app);
      const res = await createCompatible(ctx, { headers: { [name]: 'AIza-secret' } }).expect(400);
      expect(JSON.stringify(res.body)).toContain('headers');
    },
  );

  it('refuses two names that differ only in case, which fetch would join into one value', async () => {
    const ctx = await signupTestUser(app);
    const res = await createCompatible(ctx, { headers: { 'X-Session': 'a', 'x-session': 'b' } }).expect(400);
    expect(JSON.stringify(res.body)).toContain('x-session');
  });

  it('a stored header that today\'s rules refuse is dropped alone; the others are still sent', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CANNED));
      });
    });
    allowLoopbackForTests();
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    try {
      const baseUrl = `http://localhost:${(upstream.address() as AddressInfo).port}/v1`;
      const ctx = await signupTestUser(app);
      const conn = await createCompatible(ctx, { base_url: baseUrl, headers: { 'x-opencode-session': 'acx' } }).expect(201);
      // A row saved before a rule was tightened: one entry now fails validation.
      await prisma.providerConnection.update({
        where: { id: conn.body.id },
        data: { config: { base_url: baseUrl, headers: { 'x-opencode-session': 'acx', 'x-goog-api-key': 'old' } } },
      });
      await request(app)
        .post('/api/v1/gateway/models')
        .set(authHeaders(ctx))
        .send({ publicName: 'go-model', upstreamModel: 'go-model', credentialId: conn.body.id })
        .expect(201);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await request(app)
        .post('/api/v1/gateway/chat/completions')
        .set(authHeaders(ctx))
        .send({ model: 'go-model', messages: [{ role: 'user', content: 'hi' }] })
        .expect(200);

      expect(seen[0]['x-opencode-session']).toBe('acx');
      expect(seen[0]['x-goog-api-key']).toBeUndefined();
      expect(warn.mock.calls.flat().join(' ')).toContain('x-goog-api-key');
    } finally {
      jest.restoreAllMocks();
      resetSsrfAllowlist();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('refuses a header name or value that is not valid HTTP', async () => {
    const ctx = await signupTestUser(app);
    await createCompatible(ctx, { headers: { 'bad name': 'x' } }).expect(400);
    await createCompatible(ctx, { headers: { 'x-ok': 'line\r\nInjected: 1' } }).expect(400);
    await createCompatible(ctx, { headers: { 'x-ok': 42 } }).expect(400);
  });

  it('refuses headers on a provider other than openai_compatible', async () => {
    const ctx = await signupTestUser(app);
    await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'OpenAI', apiKey: OPENAI_KEY, config: { headers: { 'x-a': 'b' } } })
      .expect(400);

    const openai = await request(app)
      .post('/api/v1/gateway/connections')
      .set(authHeaders(ctx))
      .send({ provider: 'openai', label: 'OpenAI', apiKey: OPENAI_KEY, config: {} })
      .expect(201);
    await request(app)
      .patch(`/api/v1/gateway/connections/${openai.body.id}`)
      .set(authHeaders(ctx))
      .send({ config: { headers: { 'x-a': 'b' } } })
      .expect(400);
  });

  it('PATCH replaces the whole headers object, and null removes it', async () => {
    const ctx = await signupTestUser(app);
    const conn = await createCompatible(ctx, { headers: { 'x-a': '1', 'x-b': '2' } }).expect(201);

    const replaced = await request(app)
      .patch(`/api/v1/gateway/connections/${conn.body.id}`)
      .set(authHeaders(ctx))
      .send({ config: { headers: { 'x-c': '3' } } })
      .expect(200);
    expect(replaced.body.config).toEqual({ base_url: BASE_URL, headers: { 'x-c': '3' } });

    const removed = await request(app)
      .patch(`/api/v1/gateway/connections/${conn.body.id}`)
      .set(authHeaders(ctx))
      .send({ config: { headers: null } })
      .expect(200);
    expect(removed.body.config).toEqual({ base_url: BASE_URL });
  });
});
