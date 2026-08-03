import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import { TraceSettingsRepository } from '../settings/settings.repository';
import type { GatewayCallContext, GatewayCompletionRequest, GatewayResult } from '../../gateway/completions/completions.types';
import { recordGatewaySpan } from './gateway-trace.hook';
import { signupTestUser } from '../../test-utils';

const app = createApp();
const gatewayRepo = new GatewayRepository();
const settingsRepo = new TraceSettingsRepository();

/** Inserts a committed success gateway_requests row, mirroring what G2's transaction leaves behind. */
async function seedSuccessRow(teamId: string, overrides: Partial<Parameters<GatewayRepository['recordRequest']>[0]> = {}) {
  return gatewayRepo.recordRequest({
    teamId,
    provider: 'openai',
    requestedModel: 'gpt-4o-mini',
    resolvedModel: 'gpt-4o-mini',
    status: 'success',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costUsd: 0.000012,
    latencyMs: 120,
    cacheHit: false,
    ...overrides,
  });
}

const baseRequest: GatewayCompletionRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
};

function makeResult(overrides: Partial<GatewayResult> = {}): GatewayResult {
  return {
    body: {
      id: 'chatcmpl-1',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    provider: 'openai',
    model: 'gpt-4o-mini',
    costUsd: 0.000012,
    cacheHit: false,
    requestId: 'unused-in-hook',
    ...overrides,
  };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces, team_trace_settings, gateway_requests, provider_connections, prompt_aliases, prompt_versions, audit_log, prompts, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('recordGatewaySpan', () => {
  it('mints a new trace + llm span mirroring the ledger row when no traceId is supplied', async () => {
    const { teamId } = await signupTestUser(app);
    const row = await seedSuccessRow(teamId);
    const ctx: GatewayCallContext = { teamId };

    await recordGatewaySpan({ ctx, result: makeResult(), request: baseRequest, gatewayRequestId: row.id });

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1);
    expect(traces[0].status).toBe('ok');
    expect(traces[0].spanCount).toBe(1);
    expect(traces[0].totalTokens).toBe(15);

    const spans = await prisma.span.findMany({ where: { traceId: traces[0].id } });
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.kind).toBe('llm');
    expect(span.status).toBe('ok');
    expect(span.gatewayRequestId).toBe(row.id);
    expect(span.model).toBe('gpt-4o-mini');
    expect(span.provider).toBe('openai');
    expect(span.promptTokens).toBe(10);
    expect(span.completionTokens).toBe(5);
    expect(span.totalTokens).toBe(15);
    expect(Number(span.costUsd)).toBeCloseTo(0.000012, 9);
    expect(span.parentSpanRef).toBeNull();
    expect(span.latencyMs).toBe(120);
  });

  it('T8: uses ctx.traceName when creating a new trace; falls back to the last user message when absent', async () => {
    const { teamId } = await signupTestUser(app);
    const row1 = await seedSuccessRow(teamId);
    const ctx1: GatewayCallContext = { teamId, traceName: 'checkout-flow', traceTags: ['prod', 'nl'], traceMetadata: { env: 'prod' } };
    await recordGatewaySpan({ ctx: ctx1, result: makeResult(), request: baseRequest, gatewayRequestId: row1.id });
    const trace1 = (await prisma.trace.findFirst({ where: { teamId } }))!;
    expect(trace1.name).toBe('checkout-flow');
    expect(trace1.tags.sort()).toEqual(['nl', 'prod']);
    expect(trace1.metadata).toEqual({ env: 'prod' });

    await prisma.$executeRaw`TRUNCATE TABLE span_payloads, spans, traces RESTART IDENTITY CASCADE`;
    const row2 = await seedSuccessRow(teamId);
    const ctx2: GatewayCallContext = { teamId };
    await recordGatewaySpan({ ctx: ctx2, result: makeResult(), request: baseRequest, gatewayRequestId: row2.id });
    const trace2 = (await prisma.trace.findFirst({ where: { teamId } }))!;
    // With no explicit traceName, the fallback is now the request's last user
    // message ('hi' from baseRequest), not the ISO timestamp.
    expect(trace2.name).toBe('hi');
    expect(trace2.tags).toEqual([]);
    expect(trace2.metadata).toEqual({});
  });

  it('T8: merges tags/metadata into an existing trace on append rather than overwriting', async () => {
    const { teamId } = await signupTestUser(app);
    const row1 = await seedSuccessRow(teamId);
    const ctx1: GatewayCallContext = { teamId, traceTags: ['a'], traceMetadata: { k: 'v1', j: '1' } };
    await recordGatewaySpan({ ctx: ctx1, result: makeResult(), request: baseRequest, gatewayRequestId: row1.id });
    const trace = (await prisma.trace.findFirst({ where: { teamId } }))!;

    const row2 = await seedSuccessRow(teamId);
    const ctx2: GatewayCallContext = { teamId, traceId: trace.id, traceTags: ['b'], traceMetadata: { k: 'v2' } };
    await recordGatewaySpan({ ctx: ctx2, result: makeResult(), request: baseRequest, gatewayRequestId: row2.id });

    const updated = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updated!.tags.sort()).toEqual(['a', 'b']);
    expect(updated!.metadata).toEqual({ k: 'v2', j: '1' });
    // ctx2 supplies no traceName — a no-op for name (T9: last-explicit-write-wins,
    // not "frozen at creation" — see the next test for an append that DOES rename).
    expect(updated!.name).toBe(trace.name);
  });

  it('T9: a later call sharing traceId renames the trace when it supplies traceName', async () => {
    const { teamId } = await signupTestUser(app);
    const row1 = await seedSuccessRow(teamId);
    const ctx1: GatewayCallContext = { teamId };
    await recordGatewaySpan({ ctx: ctx1, result: makeResult(), request: baseRequest, gatewayRequestId: row1.id });
    const trace = (await prisma.trace.findFirst({ where: { teamId } }))!;
    expect(trace.name).toBe('hi'); // starts on the derived last-user-message fallback

    const row2 = await seedSuccessRow(teamId);
    const ctx2: GatewayCallContext = { teamId, traceId: trace.id, traceName: 'trip-planner' };
    await recordGatewaySpan({ ctx: ctx2, result: makeResult(), request: baseRequest, gatewayRequestId: row2.id });
    let updated = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updated!.name).toBe('trip-planner');

    // A third call with no traceName leaves the just-set name alone.
    const row3 = await seedSuccessRow(teamId);
    const ctx3: GatewayCallContext = { teamId, traceId: trace.id };
    await recordGatewaySpan({ ctx: ctx3, result: makeResult(), request: baseRequest, gatewayRequestId: row3.id });
    updated = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updated!.name).toBe('trip-planner');

    // A fourth call renames it again — last explicit write still wins.
    const row4 = await seedSuccessRow(teamId);
    const ctx4: GatewayCallContext = { teamId, traceId: trace.id, traceName: 'trip-planner-v2' };
    await recordGatewaySpan({ ctx: ctx4, result: makeResult(), request: baseRequest, gatewayRequestId: row4.id });
    updated = await prisma.trace.findUnique({ where: { id: trace.id } });
    expect(updated!.name).toBe('trip-planner-v2');
  });

  it('T9: gateway auto-traced span name defaults to the timestamp, and honors ctx.spanName', async () => {
    const { teamId } = await signupTestUser(app);
    const row1 = await seedSuccessRow(teamId);
    const ctx1: GatewayCallContext = { teamId };
    await recordGatewaySpan({ ctx: ctx1, result: makeResult(), request: baseRequest, gatewayRequestId: row1.id });
    const span1 = (await prisma.span.findFirst({ where: { gatewayRequestId: row1.id } }))!;
    expect(() => new Date(span1.name).toISOString()).not.toThrow();
    expect(span1.name).not.toBe('gpt-4o-mini'); // no longer defaults to the model name
    expect(span1.model).toBe('gpt-4o-mini'); // model is still on its own field

    const row2 = await seedSuccessRow(teamId);
    const ctx2: GatewayCallContext = {
      teamId,
      spanName: 'detect-intent',
      spanTags: ['prod', 'nl'],
      spanMetadata: { userId: 'u_789' },
    };
    await recordGatewaySpan({ ctx: ctx2, result: makeResult(), request: baseRequest, gatewayRequestId: row2.id });
    const span2 = (await prisma.span.findFirst({ where: { gatewayRequestId: row2.id } }))!;
    expect(span2.name).toBe('detect-intent');
    expect(span2.tags.sort()).toEqual(['nl', 'prod']);
    expect(span2.metadata).toEqual({ userId: 'u_789' });
  });

  it('appends the span under an existing trace when ctx.traceId names one for this team', async () => {
    const { teamId } = await signupTestUser(app);
    const row = await seedSuccessRow(teamId);
    const existing = await prisma.trace.create({
      data: { teamId, startedAt: new Date(), name: 'root' },
    });
    const ctx: GatewayCallContext = { teamId, traceId: existing.id, parentSpanRef: 'parent-span-1' };

    await recordGatewaySpan({ ctx, result: makeResult(), request: baseRequest, gatewayRequestId: row.id });

    const traces = await prisma.trace.findMany({ where: { teamId } });
    expect(traces).toHaveLength(1); // no new trace minted
    expect(traces[0].id).toBe(existing.id);
    expect(traces[0].spanCount).toBe(1);

    const spans = await prisma.span.findMany({ where: { traceId: existing.id } });
    expect(spans).toHaveLength(1);
    expect(spans[0].parentSpanRef).toBe('parent-span-1');
  });

  it('marks the span (and trace) status error when the ledger row is a failed call', async () => {
    const { teamId } = await signupTestUser(app);
    const row = await seedSuccessRow(teamId, {
      status: 'error',
      errorCode: 'PROVIDER_ERROR',
      resolvedModel: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
    const ctx: GatewayCallContext = { teamId };

    await recordGatewaySpan({ ctx, result: makeResult(), request: baseRequest, gatewayRequestId: row.id });

    const span = (await prisma.span.findFirst({ where: { gatewayRequestId: row.id } }))!;
    expect(span.status).toBe('error');
    expect(span.errorMessage).toBe('PROVIDER_ERROR');
    // falls back to result.model since resolvedModel is null on the ledger row
    expect(span.model).toBe('gpt-4o-mini');

    const trace = await prisma.trace.findUnique({ where: { id: span.traceId } });
    expect(trace?.status).toBe('error');
  });

  it('writes a span_payloads row only when capture resolves to on (team default)', async () => {
    const { teamId } = await signupTestUser(app);
    await settingsRepo.upsert(teamId, true);
    const row = await seedSuccessRow(teamId);
    const ctx: GatewayCallContext = { teamId };

    await recordGatewaySpan({ ctx, result: makeResult(), request: baseRequest, gatewayRequestId: row.id });

    const span = (await prisma.span.findFirst({ where: { gatewayRequestId: row.id } }))!;
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: span.id } });
    expect(payload).not.toBeNull();
    expect(payload!.input).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('skips the span_payloads row when capture resolves to off', async () => {
    const { teamId } = await signupTestUser(app);
    await settingsRepo.upsert(teamId, false); // team default OFF
    const row = await seedSuccessRow(teamId);
    const ctx: GatewayCallContext = { teamId };

    await recordGatewaySpan({ ctx, result: makeResult(), request: baseRequest, gatewayRequestId: row.id });

    const span = (await prisma.span.findFirst({ where: { gatewayRequestId: row.id } }))!;
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: span.id } });
    expect(payload).toBeNull();
  });

  it('a per-call capturePayloads override on ctx wins over the team default', async () => {
    const { teamId } = await signupTestUser(app);
    await settingsRepo.upsert(teamId, true); // team default ON
    const row = await seedSuccessRow(teamId);
    const ctx: GatewayCallContext = { teamId, capturePayloads: false }; // per-call override OFF

    await recordGatewaySpan({ ctx, result: makeResult(), request: baseRequest, gatewayRequestId: row.id });

    const span = (await prisma.span.findFirst({ where: { gatewayRequestId: row.id } }))!;
    const payload = await prisma.spanPayload.findUnique({ where: { spanId: span.id } });
    expect(payload).toBeNull();
  });

  it('is best-effort: swallows and never throws when the ledger row cannot be found', async () => {
    const { teamId } = await signupTestUser(app);
    const ctx: GatewayCallContext = { teamId };

    await expect(
      recordGatewaySpan({
        ctx,
        result: makeResult(),
        request: baseRequest,
        gatewayRequestId: '99999999-9999-9999-9999-999999999999',
      }),
    ).resolves.toBeUndefined();

    expect(await prisma.trace.count({ where: { teamId } })).toBe(0);
  });

  it('is best-effort: swallows and never throws when the transaction itself fails (FK violation on a bogus ctx.teamId)', async () => {
    // Seed a REAL ledger row for a REAL team so findById succeeds and the hook
    // proceeds past the early-return — the failure must come from inside the
    // transaction body (createTrace's team FK), not from a missing ledger row.
    const { teamId } = await signupTestUser(app);
    const row = await seedSuccessRow(teamId);
    const bogusTeamId = '11111111-1111-1111-1111-111111111111'; // no such team row
    const ctx: GatewayCallContext = { teamId: bogusTeamId };

    await expect(
      recordGatewaySpan({ ctx, result: makeResult(), request: baseRequest, gatewayRequestId: row.id }),
    ).resolves.toBeUndefined();

    // The transaction rolled back: no span/trace was left behind for this call.
    expect(await prisma.span.count({ where: { gatewayRequestId: row.id } })).toBe(0);
    expect(await prisma.trace.count()).toBe(0);
  });
});
