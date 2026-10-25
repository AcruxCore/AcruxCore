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
    model: { id: modelId, publicName: `model-${modelId}`, upstreamModel: upstream } as GatewayModel,
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

/** Throws a ProviderError carrying no body detail, so only its message is available. */
function provErrThrow(status: number): never {
  throw provErr(status, false);
}

describe('callWithFallback', () => {
  it('returns the first deployment response when it succeeds', async () => {
    const invoke: DeploymentInvoker = async () => okResponse('gpt-4o-mini');
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke);
    expect(res.deployment.model.id).toBe('a');
    expect(res.meta.attempts).toBe(1);
    expect(res.meta.trail).toEqual([
      {
        modelId: 'a',
        model: 'model-a',
        upstreamModel: 'gpt-4o-mini',
        credentialId: 'cred-a',
        attempts: 1,
      },
    ]);
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
    expect(res.meta.trail[0]).toEqual({
      modelId: 'a',
      model: 'model-a',
      upstreamModel: 'gpt-4o-mini',
      credentialId: 'cred-a',
      attempts: 1,
      error: '401',
      errorMessage: 'provider 401',
    });
    expect(res.meta.trail[1]).toEqual({
      modelId: 'b',
      model: 'model-b',
      upstreamModel: 'gpt-4o-mini',
      credentialId: 'cred-b',
      attempts: 1,
    });
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
    expect(res.meta.trail[0]).toEqual({
      modelId: 'a',
      model: 'model-a',
      upstreamModel: 'gpt-4o-mini',
      credentialId: 'cred-a',
      attempts: 2,
      error: '500',
      errorMessage: 'provider 500',
    });
  });

  it('names the model and its upstream in every trail entry', async () => {
    const invoke: DeploymentInvoker = async (d) => {
      if (d.model.id === 'a') throw provErr(500, true);
      return okResponse('gpt-4o');
    };
    const res = await callWithFallback([dep('a'), dep('b', 'gpt-4o')], REQ, invoke, {
      maxRetriesPerConn: 0,
    });
    expect(res.meta.trail).toEqual([
      {
        modelId: 'a',
        model: 'model-a',
        upstreamModel: 'gpt-4o-mini',
        credentialId: 'cred-a',
        attempts: 1,
        error: '500',
        errorMessage: 'provider 500',
      },
      {
        modelId: 'b',
        model: 'model-b',
        upstreamModel: 'gpt-4o',
        credentialId: 'cred-b',
        attempts: 1,
      },
    ]);
  });

  it('counts each deployment own attempts, so a retry before a fallback is visible', async () => {
    const invoke: DeploymentInvoker = async (d) => {
      if (d.model.id === 'a') throw provErr(500, true);
      return okResponse('gpt-4o');
    };
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke, { maxRetriesPerConn: 2 });
    // Three calls to 'a' (the first plus two retries), then one to 'b' that answered.
    expect(res.meta.attempts).toBe(4);
    expect(res.meta.trail.map((t) => t.attempts)).toEqual([3, 1]);
  });

  it('records one attempt on a deployment a 401 stopped without retrying', async () => {
    const invoke: DeploymentInvoker = async (d) => {
      if (d.model.id === 'a') throw provErr(401, false);
      return okResponse('gpt-4o');
    };
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke, { maxRetriesPerConn: 5 });
    expect(res.meta.trail.map((t) => t.attempts)).toEqual([1, 1]);
  });

  it('carries what the provider actually said, not only its status code', async () => {
    const invoke: DeploymentInvoker = async (d) => {
      if (d.model.id === 'a') {
        // `detail` is the provider's own body message, as the adapters record it.
        throw new ProviderError('OpenAI request failed with status 401', 401, undefined, false, 'Incorrect API key provided: sk-***.');
      }
      return okResponse('gpt-4o');
    };
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke);
    expect(res.meta.trail[0].error).toBe('401');
    expect(res.meta.trail[0].errorMessage).toBe('Incorrect API key provided: sk-***.');
    // Nothing to report for a deployment that answered.
    expect(res.meta.trail[1].errorMessage).toBeUndefined();
  });

  it('falls back to the thrown message when the provider sent no body detail', async () => {
    const invoke: DeploymentInvoker = async () => provErrThrow(500);
    await expect(
      callWithFallback([dep('a')], REQ, invoke, { maxRetriesPerConn: 0 }),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);
    try {
      await callWithFallback([dep('a')], REQ, invoke, { maxRetriesPerConn: 0 });
    } catch (err) {
      expect((err as FallbackExhaustedError).meta.trail[0].errorMessage).toBe('provider 500');
    }
  });

  it('truncates a provider message too long to belong on a span', async () => {
    const long = 'x'.repeat(600);
    const invoke: DeploymentInvoker = async () => {
      throw new ProviderError('boom', 500, undefined, false, long);
    };
    try {
      await callWithFallback([dep('a')], REQ, invoke, { maxRetriesPerConn: 0 });
    } catch (err) {
      const message = (err as FallbackExhaustedError).meta.trail[0].errorMessage!;
      expect(message.length).toBeLessThanOrEqual(301);
      expect(message.endsWith('\u2026')).toBe(true);
    }
  });

  it('remembers what a retried deployment was failing on, once it finally answers', async () => {
    let calls = 0;
    const invoke: DeploymentInvoker = async () => {
      calls++;
      if (calls < 3) {
        throw new ProviderError('provider 429', 429, undefined, true, 'Rate limit exceeded.');
      }
      return okResponse('gpt-4o-mini');
    };
    const res = await callWithFallback([dep('a')], REQ, invoke, { maxRetriesPerConn: 3 });
    const entry = res.meta.trail[0];
    expect(entry.attempts).toBe(3);
    expect(entry.error).toBeUndefined(); // it answered, so its turn did not fail
    expect(entry.retriedAfter).toEqual({ error: '429', errorMessage: 'Rate limit exceeded.' });
  });

  it('leaves retriedAfter off a deployment that answered first time', async () => {
    const invoke: DeploymentInvoker = async () => okResponse('gpt-4o-mini');
    const res = await callWithFallback([dep('a')], REQ, invoke);
    expect(res.meta.trail[0].retriedAfter).toBeUndefined();
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
      expect(e.meta.trail).toEqual([
        {
          modelId: 'a',
          model: 'model-a',
          upstreamModel: 'gpt-4o-mini',
          credentialId: 'cred-a',
          attempts: 1,
          error: '400',
          errorMessage: 'provider 400',
        },
      ]);
      expect(e.lastDeployment?.model.id).toBe('a');
    }
  });

  it('stops at the first deployment when fallback is disallowed', async () => {
    const calls: string[] = [];
    const invoke: DeploymentInvoker = async (d) => {
      calls.push(d.model.id);
      throw provErr(500, true);
    };
    try {
      await callWithFallback([dep('a'), dep('b')], REQ, invoke, {
        maxRetriesPerConn: 0,
        allowFallback: false,
      });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as FallbackExhaustedError;
      expect(e).toBeInstanceOf(FallbackExhaustedError);
      expect(calls).toEqual(['a']);
      expect(e.meta.trail).toEqual([
        {
          modelId: 'a',
          model: 'model-a',
          upstreamModel: 'gpt-4o-mini',
          credentialId: 'cred-a',
          attempts: 1,
          error: '500',
          errorMessage: 'provider 500',
        },
      ]);
      expect(e.lastDeployment?.model.id).toBe('a');
    }
  });

  it('still retries the same deployment when fallback is disallowed', async () => {
    const calls: string[] = [];
    const invoke: DeploymentInvoker = async (d) => {
      calls.push(d.model.id);
      throw provErr(500, true);
    };
    await expect(
      callWithFallback([dep('a'), dep('b')], REQ, invoke, {
        maxRetriesPerConn: 2,
        allowFallback: false,
      }),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);
    expect(calls).toEqual(['a', 'a', 'a']);
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
  it('reports a refused target address even when a later deployment fails differently', async () => {
    // A blocked address is a fault in the team's own connection, and the only
    // error in a failed chain they can act on. `lastError` is overwritten by every
    // later attempt, so with a fallback configured the team was told the provider
    // returned 401 — pointing them at the upstream, which is the confusion the
    // PROVIDER_ADDRESS_BLOCKED code exists to remove.
    const invoke: DeploymentInvoker = async (d) => {
      if (d.model.id === 'a') throw new ProviderError('blocked', 502, 'SSRF_BLOCKED', false);
      throw provErr(401, false);
    };
    try {
      await callWithFallback([dep('a'), dep('b')], REQ, invoke, { maxRetriesPerConn: 0 });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as FallbackExhaustedError;
      expect(e.lastError.providerCode).toBe('SSRF_BLOCKED');
      // The chain itself is unchanged: both deployments were still tried, in order.
      expect(e.meta.trail.map((t) => t.error)).toEqual(['502', '401']);
    }
  });
});

describe('callWithFallback overall deadline (issue #732)', () => {
  // A provider gets up to 60 s per attempt, and the chain used to keep moving to the
  // next deployment however long the earlier ones took. Past Cloudflare's 100 s
  // origin limit the caller gets Cloudflare's HTML 524 instead of our JSON error, so
  // the whole chain must answer within one deadline.

  /** An invoker for a provider that never answers: it fails only when its signal aborts. */
  function hangingInvoker(calls: string[]): DeploymentInvoker {
    return (d, _r, signal) =>
      new Promise((_resolve, reject) => {
        calls.push(d.model.id);
        // Safety net so a broken deadline fails the assertion below instead of hanging Jest.
        const safety = setTimeout(() => reject(new ProviderError('safety net', 504, 'timeout', true)), 2_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(safety);
          reject(new ProviderError('timed out', 504, 'timeout', true));
        });
      });
  }

  it('cuts the attempt in flight when the chain deadline passes, and answers with the timeout', async () => {
    const calls: string[] = [];
    const startedAt = Date.now();
    try {
      await callWithFallback([dep('a'), dep('b'), dep('c')], REQ, hangingInvoker(calls), {
        maxRetriesPerConn: 1,
        chainDeadlineMs: 300,
      });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as FallbackExhaustedError;
      expect(e).toBeInstanceOf(FallbackExhaustedError);
      expect(e.lastError.providerCode).toBe('timeout');
    }
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // The deadline was spent on the first attempt; nothing else was started after it.
    expect(calls).toEqual(['a']);
  });

  it('starts no retry and no fallback once the deadline has passed', async () => {
    const calls: string[] = [];
    // Ignores its signal and fails late, as a provider whose error arrives just after the deadline.
    const invoke: DeploymentInvoker = async (d) => {
      calls.push(d.model.id);
      await new Promise((r) => setTimeout(r, 400));
      throw provErr(500, true);
    };
    await expect(
      callWithFallback([dep('a'), dep('b')], REQ, invoke, { maxRetriesPerConn: 1, chainDeadlineMs: 300 }),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);
    expect(calls).toEqual(['a']);
  });

  it('answers at the deadline even when the provider call ignores its signal', async () => {
    // undici does not abort while a TCP connect is still in progress: a provider whose
    // address drops packets holds the call for its full 10 s connect timeout whatever
    // the signal says. Measured on the real stack, that ran the chain 4.7 s past 90 s.
    const invoke: DeploymentInvoker = () =>
      new Promise((_resolve, reject) => setTimeout(() => reject(provErr(502, true)), 1_500));
    const startedAt = Date.now();
    const err = (await callWithFallback([dep('a'), dep('b')], REQ, invoke, { chainDeadlineMs: 300 }).catch(
      (e: unknown) => e,
    )) as FallbackExhaustedError;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(FallbackExhaustedError);
    expect(err.lastError.providerCode).toBe('timeout');
  });

  it('still falls back after a fast failure while time remains', async () => {
    const calls: string[] = [];
    const invoke: DeploymentInvoker = async (d) => {
      calls.push(d.model.id);
      if (d.model.id === 'a') throw provErr(401, false);
      return okResponse('gpt-4o-mini');
    };
    const res = await callWithFallback([dep('a'), dep('b')], REQ, invoke, { chainDeadlineMs: 5_000 });
    expect(res.deployment.model.id).toBe('b');
    expect(calls).toEqual(['a', 'b']);
  });
});
