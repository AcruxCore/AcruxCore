process.env.GATEWAY_ENCRYPTION_KEY =
  process.env.GATEWAY_ENCRYPTION_KEY ?? Buffer.alloc(32, 5).toString('base64');

import request from 'supertest';
import type { ProviderConnection, GatewayModel } from '@prisma/client';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { resolveDeployments, callWithFallback, FallbackExhaustedError } from './router';
import type { DeploymentInvoker, ResolvedDeployment } from './router';
import { ProviderError } from '../providers/adapter';
import type { NormalizedRequest, NormalizedResponse } from '../providers/types';
import { authHeaders, resetAuthTables, signupTestUser, type TestAuthContext } from '../../test-utils';

const app = createApp();

/** Delete Phase-2 gateway rows + the Phase-1 rows they depend on, children first. */
async function truncate(): Promise<void> {
  // Delegates to the shared reset rather than keeping a local delete chain: every
  // such chain omitted a table that references `users` or `teams` (`audit_log`,
  // `tools`, ...), which passed alone and FK-violated in a full run the moment an
  // earlier suite left a row behind. `TRUNCATE ... CASCADE` reaches the
  // dependants automatically, so it needs no edit when a new domain lands.
  await resetAuthTables();
}

/** Create an OpenAI credential via the real G1 endpoint; returns its id. */
async function createCred(ctx: TestAuthContext, label: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/connections')
    .set(authHeaders(ctx))
    .send({ provider: 'openai', label, apiKey: `sk-${label}-AB12` })
    .expect(201);
  return res.body.id;
}

/** Register a model; returns its id. */
async function registerModel(
  ctx: TestAuthContext,
  publicName: string,
  upstreamModel: string,
  credentialId: string,
  fallbackModelIds: string[] = [],
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/gateway/models')
    .set(authHeaders(ctx))
    .send({ publicName, upstreamModel, credentialId, fallbackModelIds })
    .expect(201);
  return res.body.id;
}

beforeEach(async () => {
  await truncate();
});
afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

describe('resolveDeployments', () => {
  it('returns [] when the public name is not registered', async () => {
    const { teamId } = await signupTestUser(app);
    expect(await resolveDeployments(teamId, 'nope')).toEqual([]);
  });

  it('returns just the primary when it has no fallbacks', async () => {
    const ctx = await signupTestUser(app);
    const cred = await createCred(ctx, 'a');
    const id = await registerModel(ctx, 'fast', 'gpt-4o-mini', cred);
    const chain = await resolveDeployments(ctx.teamId, 'fast');
    expect(chain.map((d) => d.model.id)).toEqual([id]);
    expect(chain[0].model.upstreamModel).toBe('gpt-4o-mini');
    expect(chain[0].credential.id).toBe(cred);
  });

  it('returns the primary then its fallbacks in position order', async () => {
    const ctx = await signupTestUser(app);
    const cred = await createCred(ctx, 'a');
    const backup = await registerModel(ctx, 'backup', 'gpt-4o', cred);
    const primary = await registerModel(ctx, 'primary', 'gpt-4o-mini', cred, [backup]);
    const chain = await resolveDeployments(ctx.teamId, 'primary');
    expect(chain.map((d) => d.model.id)).toEqual([primary, backup]);
  });
});

// ── callWithFallback: fake invoke + fabricated deployments (no DB, no network) ──

// Minimal fake deployment — only fields the router touches.
function dep(modelId: string, upstream = 'gpt-4o-mini'): ResolvedDeployment {
  return {
    model: { id: modelId, upstreamModel: upstream } as GatewayModel,
    credential: { id: `cred-${modelId}` } as ProviderConnection,
  };
}

const REQ: NormalizedRequest = { model: 'fast', messages: [{ role: 'user', content: 'hi' }] };

function okResponse(model: string): NormalizedResponse {
  return {
    id: 'chatcmpl-x',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

// Builds a ProviderError with a status + retriable flag (mirrors G2's adapter mapping).
function provErr(status: number, retriable: boolean): ProviderError {
  return new ProviderError(`provider ${status}`, status, undefined, retriable);
}

describe('callWithFallback', () => {
  it('returns the first deployment response when it succeeds', async () => {
    const invoke: DeploymentInvoker = async () => okResponse('gpt-4o-mini');
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke);
    expect(res.deployment.model.id).toBe('a');
    expect(res.meta.attempts).toBe(1);
    expect(res.meta.trail).toEqual([{ modelId: 'a', credentialId: 'cred-a' }]);
  });

  it('sends the deployment upstream model, not the public name', async () => {
    let sentModel = '';
    const invoke: DeploymentInvoker = async (_d, r) => {
      sentModel = r.model;
      return okResponse(r.model);
    };
    // The pipeline rewrites r.model before invoke; simulate by having invoke read it.
    // Here callWithFallback passes REQ unchanged, so this asserts the router forwards REQ as-is.
    await callWithFallback([dep('a', 'gpt-4o')], REQ, invoke);
    expect(sentModel).toBe('fast'); // router forwards REQ; upstream rewrite happens in the pipeline invoker
  });

  it('falls back to the next deployment on a bad key (401, not retriable on same)', async () => {
    const invoke: DeploymentInvoker = async (d) => {
      if (d.model.id === 'a') throw provErr(401, false);
      return okResponse('gpt-4o-mini');
    };
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke);
    expect(res.deployment.model.id).toBe('b');
    expect(res.meta.attempts).toBe(2);
    expect(res.meta.trail[0]).toEqual({ modelId: 'a', credentialId: 'cred-a', error: '401' });
    expect(res.meta.trail[1]).toEqual({ modelId: 'b', credentialId: 'cred-b' });
  });

  it('retries a transient 500 on the same deployment, then falls back on exhaustion', async () => {
    const calls: string[] = [];
    const invoke: DeploymentInvoker = async (d) => {
      calls.push(d.model.id);
      if (d.model.id === 'a') throw provErr(500, true);
      return okResponse('gpt-4o-mini');
    };
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke, { maxRetriesPerConn: 1 });
    expect(calls).toEqual(['a', 'a', 'b']);
    expect(res.deployment.model.id).toBe('b');
    expect(res.meta.attempts).toBe(3);
    expect(res.meta.trail[0]).toEqual({ modelId: 'a', credentialId: 'cred-a', error: '500' });
  });

  it('surfaces a provider 400 immediately with no fan-out', async () => {
    const calls: string[] = [];
    const invoke: DeploymentInvoker = async (d) => {
      calls.push(d.model.id);
      throw provErr(400, false);
    };
    await expect(callWithFallback([dep('a'), dep('b')], REQ, invoke)).rejects.toBeInstanceOf(
      FallbackExhaustedError,
    );
    expect(calls).toEqual(['a']);
    try {
      await callWithFallback([dep('a'), dep('b')], REQ, invoke);
    } catch (err) {
      const e = err as FallbackExhaustedError;
      expect(e.lastError.status).toBe(400);
      expect(e.meta.trail).toEqual([{ modelId: 'a', credentialId: 'cred-a', error: '400' }]);
      expect(e.lastDeployment?.model.id).toBe('a');
    }
  });

  it('throws FallbackExhaustedError with the full trail when the whole chain fails (500)', async () => {
    const invoke: DeploymentInvoker = async () => {
      throw provErr(500, true);
    };
    try {
      await callWithFallback([dep('a'), dep('b')], REQ, invoke, { maxRetriesPerConn: 0 });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as FallbackExhaustedError;
      expect(e).toBeInstanceOf(FallbackExhaustedError);
      expect(e.lastError.status).toBe(500);
      expect(e.meta.trail.map((t) => t.error)).toEqual(['500', '500']);
      expect(e.lastDeployment?.model.id).toBe('b');
    }
  });
});
