import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent } from '../../test-utils';

const app = createApp();

let n = 0;
function nextEmail(): string {
  return `t6-${++n}-${Date.now()}@example.com`;
}

async function truncateTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    span_payloads, spans, trace_feedback, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    gateway_model_fallbacks, gateway_models,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`);
}

interface Ctx {
  agent: ReturnType<typeof request.agent>;
  apiKey: string;
  teamId: string;
}

/** Signs up an owner and returns a session agent + a personal API key + teamId. */
async function signup(): Promise<Ctx> {
  const { agent, teamId } = await authedAgent(app);
  const keyRes = await agent.post('/api/v1/api-keys').send({ name: 't6' }).expect(201);
  return { agent, apiKey: keyRes.body.key, teamId };
}

/** Signs up a second user and adds them to an existing team (default role: editor). */
async function addTeammate(
  teamId: string,
  role: 'owner' | 'admin' | 'editor' | 'viewer' = 'editor',
): Promise<{ agent: Ctx['agent']; userId: string }> {
  // Real signup through Better Auth, then join the target team.
  const teammate = await authedAgent(app, { email: nextEmail() });
  const agent = teammate.agent;
  const userId = teammate.userId;

  // Add them to the target team and switch their active team to it.
  await prisma.teamMember.create({ data: { userId, teamId, role } });
  await agent.post('/api/v1/auth/switch-team').send({ teamId }).expect(200);

  return { agent, userId };
}

/**
 * Arranges a trace with a single llm span via T2 ingest, returning the trace id
 * and the span ref. `promptVersionId` is stamped when provided.
 */
async function postTrace(
  agent: Ctx['agent'],
  opts: { spanRef?: string; model?: string; promptVersionId?: string } = {},
): Promise<{ traceId: string; spanRef: string }> {
  const spanRef = opts.spanRef ?? 's1';
  const res = await agent
    .post('/api/v1/traces')
    .send({
      traces: [
        {
          name: 'support-agent-run',
          spans: [
            {
              spanId: spanRef,
              name: opts.model ?? 'gpt-4o-mini',
              kind: 'llm',
              status: 'ok',
              startTime: new Date('2026-07-04T10:00:00Z').toISOString(),
              model: opts.model ?? 'gpt-4o-mini',
              ...(opts.promptVersionId ? { promptVersionId: opts.promptVersionId } : {}),
            },
          ],
        },
      ],
    })
    .expect(200);
  return { traceId: res.body.traceIds[0], spanRef };
}

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

// ── POST /traces/:id/feedback ────────────────────────────────────────────────

describe('POST /api/v1/traces/:id/feedback', () => {
  it('attaches trace-level feedback, returns it, and persists a team+trace-scoped row', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    const res = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: -1, comment: 'Cited the wrong policy.' })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.traceId).toBe(traceId);
    expect(res.body.spanId).toBeNull();
    expect(res.body.rating).toBe(-1);
    expect(res.body.comment).toBe('Cited the wrong policy.');
    expect(res.body.source).toBe('user');
    expect(res.body.createdBy).toBeDefined(); // the signed-in owner's id

    const rows = await prisma.traceFeedback.findMany({ where: { teamId: ctx.teamId, traceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(-1);
    expect(rows[0].spanId).toBeNull();
  });

  it('lists feedback newest-first via GET /traces/:id/feedback', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    await ctx.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: 1, comment: 'first' }).expect(201);
    await ctx.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: -1, comment: 'second' }).expect(201);

    const res = await ctx.agent.get(`/api/v1/traces/${traceId}/feedback`).expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].comment).toBe('second'); // newest first
    expect(res.body.data[1].comment).toBe('first');
  });

  it('surfaces feedback inside GET /traces/:id (T4 detail extension)', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: 1, label: 'good_answer' })
      .expect(201);

    const res = await ctx.agent.get(`/api/v1/traces/${traceId}`).expect(200);
    expect(Array.isArray(res.body.feedback)).toBe(true);
    expect(res.body.feedback).toHaveLength(1);
    expect(res.body.feedback[0].label).toBe('good_answer');
    expect(res.body.feedback[0].rating).toBe(1);
  });

  it('attaches span-level feedback when spanId belongs to the trace', async () => {
    const ctx = await signup();
    const { traceId, spanRef } = await postTrace(ctx.agent);

    const res = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: 1, spanId: spanRef })
      .expect(201);

    expect(res.body.spanId).toBe(spanRef); // echoed as the OTel ref, never a UUID

    // The DB stores the internal span UUID, not the ref.
    const row = await prisma.traceFeedback.findFirst({ where: { traceId } });
    const span = await prisma.span.findFirst({ where: { traceId, spanRef } });
    expect(row!.spanId).toBe(span!.id);
    expect(row!.spanId).not.toBe(spanRef);
  });

  it('returns 400 INVALID_SPAN (not 404/500) when spanId belongs to a different trace', async () => {
    const ctx = await signup();
    const traceA = await postTrace(ctx.agent, { spanRef: 's1' });
    const traceB = await postTrace(ctx.agent, { spanRef: 's2' });

    const res = await ctx.agent
      .post(`/api/v1/traces/${traceA.traceId}/feedback`)
      .send({ rating: 1, spanId: traceB.spanRef }) // 's2' does not exist under trace A
      .expect(400);

    expect(res.body.error.code).toBe('INVALID_SPAN');
  });

  it('returns 400 VALIDATION_ERROR (distinct from INVALID_SPAN) for an empty body', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    const res = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ source: 'end_user' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.code).not.toBe('INVALID_SPAN');
  });

  it('returns 400 VALIDATION_ERROR for a rating out of range', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    const res = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: 9 })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('via a team-scoped API key (no user identity): created_by is null and source is respected', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    // Team-scoped keys (scope='team', userId=null) carry no user identity — distinct
    // from the personal key returned by signup(), which DOES resolve to req.user.
    const teamKeyRes = await ctx.agent
      .post(`/api/v1/teams/${ctx.teamId}/api-keys`)
      .send({ name: 't6-team-key' })
      .expect(201);
    const teamKey = teamKeyRes.body.key as string;

    const res = await request(app)
      .post(`/api/v1/traces/${traceId}/feedback`)
      .set('Authorization', `Bearer ${teamKey}`)
      .send({ rating: -1, comment: 'bad', source: 'end_user' })
      .expect(201);

    expect(res.body.createdBy).toBeNull();
    expect(res.body.source).toBe('end_user');

    const row = await prisma.traceFeedback.findFirst({ where: { traceId } });
    expect(row!.createdBy).toBeNull();

    // GET is equally open to a no-role, no-identity team key (any role, per the auth matrix).
    const listRes = await request(app)
      .get(`/api/v1/traces/${traceId}/feedback`)
      .set('Authorization', `Bearer ${teamKey}`)
      .expect(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].comment).toBe('bad');
  });

  it('a SESSION user maps created_by to the user id (contrast with the team-key case above)', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    const res = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: 1 })
      .expect(201);

    expect(typeof res.body.createdBy).toBe('string');

    const row = await prisma.traceFeedback.findFirst({ where: { traceId } });
    expect(row!.createdBy).toBe(res.body.createdBy);
    expect(row!.createdBy).not.toBeNull();
  });

  it('a PERSONAL API key (has a user identity) also maps created_by to that user id', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    const res = await request(app)
      .post(`/api/v1/traces/${traceId}/feedback`)
      .set('Authorization', `Bearer ${ctx.apiKey}`)
      .send({ rating: 1, source: 'developer' })
      .expect(201);

    expect(typeof res.body.createdBy).toBe('string');
    expect(res.body.source).toBe('developer');

    const row = await prisma.traceFeedback.findFirst({ where: { traceId } });
    expect(row!.createdBy).toBe(res.body.createdBy);
    expect(row!.createdBy).not.toBeNull();
  });

  it('returns 404 (not a leak) when posting to a trace in another team', async () => {
    const alice = await signup();
    const bob = await signup();
    const { traceId } = await postTrace(alice.agent);

    const res = await bob.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: 1 })
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');

    // Alice's trace must still have zero feedback rows — Bob's call did not attach anything.
    const rows = await prisma.traceFeedback.findMany({ where: { traceId } });
    expect(rows).toHaveLength(0);
  });

  it("returns 404 even when the spanId ref IS valid in the foreign team's trace (team check precedes span resolution)", async () => {
    const alice = await signup();
    const bob = await signup();
    const { traceId, spanRef } = await postTrace(alice.agent, { spanRef: 'valid-in-a' });

    const res = await bob.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: 1, spanId: spanRef })
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.code).not.toBe('INVALID_SPAN');
  });

  it("team isolation: team B never sees team A's feedback via GET, and gets 404 not empty data", async () => {
    const alice = await signup();
    const bob = await signup();
    const { traceId } = await postTrace(alice.agent);
    await alice.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: 1 }).expect(201);

    // Bob cannot read the feedback list for a trace he does not own.
    const res = await bob.agent.get(`/api/v1/traces/${traceId}/feedback`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 401 with no auth at all (POST and GET)', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    await request(app).post(`/api/v1/traces/${traceId}/feedback`).send({ rating: 1 }).expect(401);
    await request(app).get(`/api/v1/traces/${traceId}/feedback`).expect(401);
  });
});

// ── PATCH /traces/:id/feedback/:feedbackId ───────────────────────────────────

describe('PATCH /api/v1/traces/:id/feedback/:feedbackId', () => {
  it("the author edits their own trace-level feedback in place, and updatedAt advances", async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);
    const created = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: -1, comment: 'Cited the wrong policy.' })
      .expect(201);

    const res = await ctx.agent
      .patch(`/api/v1/traces/${traceId}/feedback/${created.body.id}`)
      .send({ rating: 1, comment: 'Actually correct on review.' })
      .expect(200);

    expect(res.body.id).toBe(created.body.id);
    expect(res.body.rating).toBe(1);
    expect(res.body.comment).toBe('Actually correct on review.');
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(new Date(created.body.createdAt).getTime());

    const row = await prisma.traceFeedback.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.rating).toBe(1);
    expect(row.comment).toBe('Actually correct on review.');
  });

  it("the author edits their own span-level feedback, spanId still echoed as the OTel ref", async () => {
    const ctx = await signup();
    const { traceId, spanRef } = await postTrace(ctx.agent);
    const created = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: -1, spanId: spanRef })
      .expect(201);

    const res = await ctx.agent
      .patch(`/api/v1/traces/${traceId}/feedback/${created.body.id}`)
      .send({ rating: 1 })
      .expect(200);

    expect(res.body.rating).toBe(1);
    expect(res.body.spanId).toBe(spanRef);
  });

  it('a partial edit leaves fields not present in the body unchanged', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);
    const created = await ctx.agent
      .post(`/api/v1/traces/${traceId}/feedback`)
      .send({ rating: -1, label: 'wrong_answer', comment: 'Missed the doc.' })
      .expect(201);

    const res = await ctx.agent
      .patch(`/api/v1/traces/${traceId}/feedback/${created.body.id}`)
      .send({ rating: 1 })
      .expect(200);

    expect(res.body.rating).toBe(1);
    expect(res.body.label).toBe('wrong_answer');
    expect(res.body.comment).toBe('Missed the doc.');
  });

  it('a teammate who is not the author gets 403, and the row is unchanged', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);
    const created = await ctx.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: -1 }).expect(201);

    const mate = await addTeammate(ctx.teamId);
    const res = await mate.agent
      .patch(`/api/v1/traces/${traceId}/feedback/${created.body.id}`)
      .send({ rating: 1 })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
    const row = await prisma.traceFeedback.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.rating).toBe(-1);
  });

  it('feedback posted via a team API key (createdBy null) cannot be edited by anyone', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);
    const teamKeyRes = await ctx.agent
      .post(`/api/v1/teams/${ctx.teamId}/api-keys`)
      .send({ name: 'ci' })
      .expect(201);
    const created = await request(app)
      .post(`/api/v1/traces/${traceId}/feedback`)
      .set('Authorization', `Bearer ${teamKeyRes.body.key}`)
      .send({ rating: -1 })
      .expect(201);
    expect(created.body.createdBy).toBeNull();

    const res = await ctx.agent
      .patch(`/api/v1/traces/${traceId}/feedback/${created.body.id}`)
      .send({ rating: 1 })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('clearing rating/label/comment down to nothing returns 400 and leaves the row unchanged', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);
    const created = await ctx.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: -1 }).expect(201);

    const res = await ctx.agent
      .patch(`/api/v1/traces/${traceId}/feedback/${created.body.id}`)
      .send({ rating: null })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const row = await prisma.traceFeedback.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.rating).toBe(-1);
  });

  it('unknown feedback id returns 404', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);

    const res = await ctx.agent
      .patch(`/api/v1/traces/${traceId}/feedback/00000000-0000-0000-0000-000000000000`)
      .send({ rating: 1 })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it("a foreign team's feedback id returns 404, not 403 (never confirms it exists)", async () => {
    const alice = await signup();
    const { traceId } = await postTrace(alice.agent);
    const created = await alice.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: -1 }).expect(201);

    const bob = await signup();
    const { traceId: bobTraceId } = await postTrace(bob.agent);
    const res = await bob.agent
      .patch(`/api/v1/traces/${bobTraceId}/feedback/${created.body.id}`)
      .send({ rating: 1 })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 401 with no auth', async () => {
    const ctx = await signup();
    const { traceId } = await postTrace(ctx.agent);
    const created = await ctx.agent.post(`/api/v1/traces/${traceId}/feedback`).send({ rating: -1 }).expect(201);

    await request(app)
      .patch(`/api/v1/traces/${traceId}/feedback/${created.body.id}`)
      .send({ rating: 1 })
      .expect(401);
  });
});

// ── GET /traces/feedback/summary ─────────────────────────────────────────────

describe('GET /api/v1/traces/feedback/summary', () => {
  it('aggregates avg rating + counts per prompt version across two versions', async () => {
    const ctx = await signup();

    // Real prompt + two versions → genuine prompt_version ids.
    const prompt = await ctx.agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201);
    const v1 = await ctx.agent
      .post(`/api/v1/prompts/${prompt.body.id}/versions`)
      .send({ messages: [{ role: 'system', content: 'Hello {{ name }}' }] })
      .expect(201);
    const v2 = await ctx.agent
      .post(`/api/v1/prompts/${prompt.body.id}/versions`)
      .send({ messages: [{ role: 'system', content: 'Hi {{ name }}!' }] })
      .expect(201);

    // One trace per version, each with an llm span stamped with that version id.
    const t1 = await postTrace(ctx.agent, { spanRef: 'a1', promptVersionId: v1.body.id });
    const t2 = await postTrace(ctx.agent, { spanRef: 'b1', promptVersionId: v2.body.id });

    // v1: ratings 1 and -1  → count 2, avg 0, down 1
    await ctx.agent.post(`/api/v1/traces/${t1.traceId}/feedback`).send({ rating: 1 }).expect(201);
    await ctx.agent.post(`/api/v1/traces/${t1.traceId}/feedback`).send({ rating: -1 }).expect(201);
    // v2: ratings 1 and 1  → count 2, avg 1, down 0
    await ctx.agent.post(`/api/v1/traces/${t2.traceId}/feedback`).send({ rating: 1 }).expect(201);
    await ctx.agent.post(`/api/v1/traces/${t2.traceId}/feedback`).send({ rating: 1 }).expect(201);

    const res = await ctx.agent
      .get('/api/v1/traces/feedback/summary?group_by=prompt_version')
      .expect(200);

    expect(res.body.groupBy).toBe('prompt_version');
    const byKey = Object.fromEntries(res.body.buckets.map((b: { key: string }) => [b.key, b]));

    expect(byKey[v1.body.id].count).toBe(2);
    expect(byKey[v1.body.id].avgRating).toBeCloseTo(0, 6);
    expect(byKey[v1.body.id].downCount).toBe(1);

    expect(byKey[v2.body.id].count).toBe(2);
    expect(byKey[v2.body.id].avgRating).toBeCloseTo(1, 6);
    expect(byKey[v2.body.id].downCount).toBe(0);
  });

  it('aggregates avg rating + counts per model, defaulting to a 30-day window', async () => {
    const ctx = await signup();

    const tMini = await postTrace(ctx.agent, { spanRef: 'm1', model: 'gpt-4o-mini' });
    const tBig = await postTrace(ctx.agent, { spanRef: 'b1', model: 'gpt-4o' });

    // gpt-4o-mini: ratings 1, -1 → count 2, avg 0, down 1
    await ctx.agent.post(`/api/v1/traces/${tMini.traceId}/feedback`).send({ rating: 1 }).expect(201);
    await ctx.agent.post(`/api/v1/traces/${tMini.traceId}/feedback`).send({ rating: -1 }).expect(201);
    // gpt-4o: rating 1 → count 1, avg 1, down 0
    await ctx.agent.post(`/api/v1/traces/${tBig.traceId}/feedback`).send({ rating: 1 }).expect(201);

    const res = await ctx.agent.get('/api/v1/traces/feedback/summary?group_by=model').expect(200);
    expect(res.body.groupBy).toBe('model');
    const byKey = Object.fromEntries(res.body.buckets.map((b: { key: string }) => [b.key, b]));

    expect(byKey['gpt-4o-mini'].count).toBe(2);
    expect(byKey['gpt-4o-mini'].avgRating).toBeCloseTo(0, 6);
    expect(byKey['gpt-4o-mini'].downCount).toBe(1);

    expect(byKey['gpt-4o'].count).toBe(1);
    expect(byKey['gpt-4o'].avgRating).toBeCloseTo(1, 6);
    expect(byKey['gpt-4o'].downCount).toBe(0);
  });

  it('the 30-day default window excludes feedback outside it (not just includes recent)', async () => {
    const ctx = await signup();
    const tMini = await postTrace(ctx.agent, { spanRef: 'w1', model: 'gpt-4o-mini' });
    await ctx.agent.post(`/api/v1/traces/${tMini.traceId}/feedback`).send({ rating: 1 }).expect(201);

    // Feedback was just created "now". Ask for a window ending ~40 days ago —
    // the default 30-day lookback then covers ~[70d, 40d] ago, which contains
    // none of it. If the date filter were a no-op, this bucket would show count 1.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const res = await ctx.agent
      .get(`/api/v1/traces/feedback/summary?group_by=model&to=${fortyDaysAgo}`)
      .expect(200);

    const byKey = Object.fromEntries(res.body.buckets.map((b: { key: string }) => [b.key, b]));
    expect(byKey['gpt-4o-mini']).toBeUndefined();
  });

  it('team isolation: another team feedback never contributes to the summary', async () => {
    const alice = await signup();
    const bob = await signup();

    const aliceTrace = await postTrace(alice.agent, { spanRef: 'a1', model: 'gpt-4o' });
    await alice.agent.post(`/api/v1/traces/${aliceTrace.traceId}/feedback`).send({ rating: 1 }).expect(201);

    const bobTrace = await postTrace(bob.agent, { spanRef: 'b1', model: 'gpt-4o' });
    await bob.agent.post(`/api/v1/traces/${bobTrace.traceId}/feedback`).send({ rating: -1 }).expect(201);

    const res = await alice.agent.get('/api/v1/traces/feedback/summary?group_by=model').expect(200);
    const byKey = Object.fromEntries(res.body.buckets.map((b: { key: string }) => [b.key, b]));

    // Only alice's positive rating should be reflected — bob's -1 must not leak in.
    expect(byKey['gpt-4o'].count).toBe(1);
    expect(byKey['gpt-4o'].avgRating).toBeCloseTo(1, 6);
    expect(byKey['gpt-4o'].downCount).toBe(0);
  });

  it('returns 401 with no auth', async () => {
    await request(app).get('/api/v1/traces/feedback/summary').expect(401);
  });
});

// ── GET /traces/feedback (T10: team-wide raw feed) ───────────────────────────

describe('GET /api/v1/traces/feedback', () => {
  it('lists feedback across traces newest-first, echoing spanRef, paginated', async () => {
    const ctx = await signup();
    const t1 = await postTrace(ctx.agent, { spanRef: 'a1' });
    const t2 = await postTrace(ctx.agent, { spanRef: 'b1' });

    await ctx.agent.post(`/api/v1/traces/${t1.traceId}/feedback`).send({ rating: 1, comment: 'first' }).expect(201);
    await ctx.agent
      .post(`/api/v1/traces/${t2.traceId}/feedback`)
      .send({ rating: -1, spanId: t2.spanRef, comment: 'second' })
      .expect(201);

    const res = await ctx.agent.get('/api/v1/traces/feedback?limit=1').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].comment).toBe('second'); // newest first
    expect(res.body.data[0].traceId).toBe(t2.traceId);
    expect(res.body.data[0].spanId).toBe(t2.spanRef); // echoed as the OTel ref

    const page2 = await ctx.agent.get('/api/v1/traces/feedback?limit=1&page=2').expect(200);
    expect(page2.body.data[0].comment).toBe('first');
    expect(page2.body.data[0].spanId).toBeNull();
  });

  it('team isolation: never returns another team feedback', async () => {
    const alice = await signup();
    const bob = await signup();
    const aliceTrace = await postTrace(alice.agent, { spanRef: 'a1' });
    await alice.agent.post(`/api/v1/traces/${aliceTrace.traceId}/feedback`).send({ rating: 1 }).expect(201);

    const bobTrace = await postTrace(bob.agent, { spanRef: 'b1' });
    await bob.agent.post(`/api/v1/traces/${bobTrace.traceId}/feedback`).send({ rating: -1 }).expect(201);

    const res = await alice.agent.get('/api/v1/traces/feedback').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].traceId).toBe(aliceTrace.traceId);
  });

  it('returns 401 with no auth', async () => {
    await request(app).get('/api/v1/traces/feedback').expect(401);
  });
});
