import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { authedAgent, registerTestModel } from '../../test-utils';

const app = createApp();

/** Posts a batch of traces via the real ingestion API; returns the created trace ids. */
async function ingest(
  agent: ReturnType<typeof request.agent>,
  traces: unknown[],
): Promise<string[]> {
  const res = await agent.post('/api/v1/traces').send({ traces }).expect(200);
  return res.body.traceIds as string[];
}

const iso = (d: Date): string => d.toISOString();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    span_payloads, spans, traces, team_trace_settings,
    gateway_requests, gateway_cache, budgets, virtual_keys, provider_connections,
    audit_log, prompt_aliases, prompt_versions, prompts,
    api_keys, team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/v1/traces — filters', () => {
  it('model filter returns each matching trace exactly once (span-level EXISTS)', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tMini] = await ingest(agent, [
      {
        name: 'mini-run',
        spans: [
          { spanId: 's1', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', startTime: iso(now), model: 'gpt-4o-mini' },
          { spanId: 's2', parentSpanId: 's1', name: 'search_docs', kind: 'tool', status: 'ok', startTime: iso(now) },
        ],
      },
    ]);
    await ingest(agent, [
      { name: 'big-run', spans: [{ spanId: 'b1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), model: 'gpt-4o' }] },
    ]);

    const res = await agent.get('/api/v1/traces?model=gpt-4o-mini').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tMini);
    expect(res.body.total).toBe(1);
  });

  it('prompt_version_id filter returns only traces whose spans used that version', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const prompt = (await agent.post('/api/v1/prompts').send({ name: 'greeting' }).expect(201)).body;
    const version = (await agent
      .post(`/api/v1/prompts/${prompt.id}/versions`)
      .send({ messages: [{ role: 'user', content: 'Hi {{ name }}' }] })
      .expect(201)).body;

    const [tVersioned] = await ingest(agent, [
      { name: 'versioned-run', spans: [{ spanId: 'v1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), promptVersionId: version.id }] },
    ]);
    await ingest(agent, [
      { name: 'unversioned-run', spans: [{ spanId: 'u1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);

    const res = await agent.get(`/api/v1/traces?prompt_version_id=${version.id}`).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tVersioned);
    expect(res.body.total).toBe(1);
  });

  it('q="" (empty/whitespace) is a no-op and returns all traces', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    await ingest(agent, [
      { name: 'agent-a', spans: [{ spanId: 'a1', name: 'search_docs', kind: 'tool', status: 'ok', startTime: iso(now) }] },
    ]);
    await ingest(agent, [
      { name: 'agent-b', spans: [{ spanId: 'b1', name: 'summarize', kind: 'tool', status: 'ok', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces?q=%20').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it('combined filters AND together (model + status both must match)', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tBoth] = await ingest(agent, [
      { name: 'both-match', spans: [{ spanId: 'm1', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', startTime: iso(now), model: 'gpt-4o-mini' }] },
    ]);
    // Matches model only (status=error).
    await ingest(agent, [
      { name: 'model-only', spans: [{ spanId: 'm2', name: 'gpt-4o-mini', kind: 'llm', status: 'error', startTime: iso(now), model: 'gpt-4o-mini', error: 'boom' }] },
    ]);
    // Matches status only (different model).
    await ingest(agent, [
      { name: 'status-only', spans: [{ spanId: 'm3', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), model: 'gpt-4o' }] },
    ]);

    const res = await agent.get('/api/v1/traces?model=gpt-4o-mini&status=ok').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tBoth);
    expect(res.body.total).toBe(1);
  });

  it('status=error returns only errored traces (single-span fixture)', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tErr] = await ingest(agent, [
      { name: 'boom', spans: [{ spanId: 'e1', name: 'gpt-4o', kind: 'llm', status: 'error', startTime: iso(now), error: 'nope' }] },
    ]);
    await ingest(agent, [
      { name: 'fine', spans: [{ spanId: 'o1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces?status=error').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tErr);
  });

  /**
   * Issue #452 — `status=error` says a run broke; it cannot say WHY, because every kind
   * of failure rolls up to the same red trace. These two filters read the classifier's
   * own attributes instead, which is what makes "show me the runs an upstream tool 500'd"
   * an answerable question.
   */
  it('error_type selects only traces whose spans recorded that kind of failure', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tHttp] = await ingest(agent, [
      {
        name: 'tool-broke',
        spans: [
          {
            spanId: 'h1', name: 'get_weather', kind: 'tool', status: 'error', startTime: iso(now),
            error: 'Upstream returned HTTP 503.',
            attributes: { errorType: 'http_status', httpStatus: 503 },
          },
        ],
      },
    ]);
    await ingest(agent, [
      {
        name: 'model-broke',
        spans: [
          {
            spanId: 'p1', name: 'gpt-4o', kind: 'llm', status: 'error', startTime: iso(now),
            error: 'rate_limit', attributes: { errorType: 'provider_error' },
          },
        ],
      },
    ]);

    // Both traces are red, so `status=error` cannot separate them — that is the point.
    expect((await agent.get('/api/v1/traces?status=error').expect(200)).body.data).toHaveLength(2);

    const res = await agent.get('/api/v1/traces?error_type=http_status').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tHttp);
    expect(res.body.total).toBe(1);
  });

  it('rejects an error_type outside the shared vocabulary', async () => {
    const { agent } = await authedAgent(app);
    await agent.get('/api/v1/traces?error_type=banana').expect(400);
  });

  /**
   * Issue #460 — `errorType` answers "what kind of thing went wrong" from a fixed list;
   * `errorCode` is the slug the tool's own owner chose, which is how a team names and
   * counts its own failure modes. A free-text `q` cannot stand in for it: `q` is a
   * substring match over the whole attributes JSON, so it also matches the slug written
   * anywhere else, and a rate built on that is not trustworthy.
   */
  it('error_code selects only traces whose spans declared that slug', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tNotFound] = await ingest(agent, [
      {
        name: 'atlantis-prime',
        spans: [
          {
            spanId: 'c1', name: 'get_weather_brief', kind: 'tool', status: 'error', startTime: iso(now),
            error: 'No such place.',
            attributes: { errorType: 'tool_declared', errorCode: 'location_not_found' },
          },
        ],
      },
    ]);
    await ingest(agent, [
      {
        name: 'hyderabad',
        spans: [
          {
            spanId: 'c2', name: 'get_weather_brief', kind: 'tool', status: 'ok', startTime: iso(now),
            attributes: { errorType: 'tool_declared', errorCode: 'ambiguous_city' },
          },
        ],
      },
    ]);

    // Both runs declared their own failure, so `error_type` cannot separate them — the
    // slug is the only thing that tells these two failure modes apart.
    expect((await agent.get('/api/v1/traces?error_type=tool_declared').expect(200)).body.data).toHaveLength(2);

    const res = await agent.get('/api/v1/traces?error_code=location_not_found').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tNotFound);
    expect(res.body.total).toBe(1);
  });

  it('error_code matches the whole slug, not the slug written inside another attribute', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tDeclared] = await ingest(agent, [
      {
        name: 'declared-it',
        spans: [
          {
            spanId: 'w1', name: 'get_weather_brief', kind: 'tool', status: 'error', startTime: iso(now),
            attributes: { errorType: 'tool_declared', errorCode: 'location_not_found' },
          },
        ],
      },
    ]);
    // The same words in prose on a span that declared nothing. This is the trace that
    // makes `q=location_not_found` unusable as a count.
    await ingest(agent, [
      {
        name: 'only-mentions-it',
        spans: [
          {
            spanId: 'w2', name: 'gpt-4o-mini', kind: 'llm', status: 'ok', startTime: iso(now),
            attributes: { note: 'retrying after location_not_found' },
          },
        ],
      },
    ]);

    expect((await agent.get('/api/v1/traces?q=location_not_found').expect(200)).body.data).toHaveLength(2);

    const res = await agent.get('/api/v1/traces?error_code=location_not_found').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tDeclared);
  });

  it('rejects a blank error_code rather than matching every trace', async () => {
    const { agent } = await authedAgent(app);
    await agent.get('/api/v1/traces?error_code=').expect(400);
  });

  it('has_warning finds a green trace carrying a warning, and excludes it in reverse', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    // The case the whole feature exists for: an entirely OK run that still has something
    // worth seeing. No status filter can find this trace.
    const [tWarn] = await ingest(agent, [
      {
        name: 'stale-data',
        spans: [
          {
            spanId: 'w1', name: 'get_weather', kind: 'tool', status: 'ok', startTime: iso(now),
            attributes: {
              errorType: 'schema_mismatch',
              warning: { type: 'schema_mismatch', message: "result is missing required property 'tempC'" },
            },
          },
        ],
      },
    ]);
    const [tClean] = await ingest(agent, [
      { name: 'clean', spans: [{ spanId: 'c1', name: 'get_weather', kind: 'tool', status: 'ok', startTime: iso(now) }] },
    ]);

    const warned = await agent.get('/api/v1/traces?has_warning=true').expect(200);
    expect(warned.body.data).toHaveLength(1);
    expect(warned.body.data[0].id).toBe(tWarn);
    expect(warned.body.data[0].status).toBe('ok'); // a warning is not a verdict

    const clean = await agent.get('/api/v1/traces?has_warning=false').expect(200);
    expect(clean.body.data.map((t: { id: string }) => t.id)).toEqual([tClean]);
  });

  it('q matches on span name (case-insensitive substring over span attributes/name)', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tSearch] = await ingest(agent, [
      { name: 'agent-a', spans: [{ spanId: 'a1', name: 'search_docs', kind: 'tool', status: 'ok', startTime: iso(now) }] },
    ]);
    await ingest(agent, [
      { name: 'agent-b', spans: [{ spanId: 'b1', name: 'summarize', kind: 'tool', status: 'ok', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces?q=SEARCH').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tSearch);
  });

  it('min_cost_usd and min_tokens threshold on trace rollups', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tBig] = await ingest(agent, [
      { name: 'pricey', spans: [{ spanId: 'p1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), costUsd: 0.01, usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1000 } }] },
    ]);
    await ingest(agent, [
      { name: 'cheap', spans: [{ spanId: 'c1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), costUsd: 0.001, usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 } }] },
    ]);

    const byCost = await agent.get('/api/v1/traces?min_cost_usd=0.005').expect(200);
    expect(byCost.body.data.map((t: { id: string }) => t.id)).toEqual([tBig]);

    const byTokens = await agent.get('/api/v1/traces?min_tokens=500').expect(200);
    expect(byTokens.body.data.map((t: { id: string }) => t.id)).toEqual([tBig]);
  });

  it('min_latency_ms filters on trace duration (ended_at − started_at)', async () => {
    const { agent } = await authedAgent(app);
    const start = new Date();
    const end = new Date(start.getTime() + 2000); // 2s span
    await ingest(agent, [
      { name: 'slow', spans: [{ spanId: 'l1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(start), endTime: iso(end) }] },
    ]);

    const included = await agent.get('/api/v1/traces?min_latency_ms=1000').expect(200);
    expect(included.body.total).toBe(1);

    const excluded = await agent.get('/api/v1/traces?min_latency_ms=5000').expect(200);
    expect(excluded.body.total).toBe(0);
  });

  it('session_id filter narrows to one session', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [tChat1] = await ingest(agent, [
      { name: 'r1', sessionId: 'chat-1', spans: [{ spanId: 'x1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    await ingest(agent, [
      { name: 'r2', sessionId: 'chat-2', spans: [{ spanId: 'x2', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces?session_id=chat-1').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(tChat1);
    expect(res.body.data[0].sessionId).toBe('chat-1');
  });

  it('date range narrows: a now-bracket includes; a wholly-past range excludes', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    await ingest(agent, [
      { name: 'today', spans: [{ spanId: 'd1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    const day = 24 * 60 * 60 * 1000;

    const included = await agent
      .get(`/api/v1/traces?from=${iso(new Date(now.getTime() - day))}&to=${iso(new Date(now.getTime() + day))}`)
      .expect(200);
    expect(included.body.total).toBe(1);

    const excluded = await agent
      .get(`/api/v1/traces?from=${iso(new Date(now.getTime() - 60 * day))}&to=${iso(new Date(now.getTime() - 30 * day))}`)
      .expect(200);
    expect(excluded.body.total).toBe(0);
  });

  it('defaults to the last 30 days when no range is given', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    await ingest(agent, [
      { name: 'recent', spans: [{ spanId: 'r1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    const res = await agent.get('/api/v1/traces').expect(200);
    expect(res.body.total).toBe(1);
  });

  it('paginates newest-first with total/page/limit', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await ingest(agent, [
        { name: `run-${i}`, spans: [{ spanId: `s${i}`, name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
      ]);
    }
    const res = await agent.get('/api/v1/traces?page=1&limit=2').expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it('returns 400 for an invalid status enum', async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get('/api/v1/traces?status=banana').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never includes another team traces (isolation)', async () => {
    const a = await authedAgent(app);
    const now = new Date();
    await ingest(a.agent, [
      { name: 'a-run', spans: [{ spanId: 'a1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    const b = await authedAgent(app);

    const res = await b.agent.get('/api/v1/traces').expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });

  it('never matches another team spans via the model EXISTS filter (cross-tenant span leak)', async () => {
    const a = await authedAgent(app);
    const now = new Date();
    await ingest(a.agent, [
      { name: 'a-run', spans: [{ spanId: 'a1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now), model: 'gpt-4o' }] },
    ]);
    const b = await authedAgent(app);

    const res = await b.agent.get('/api/v1/traces?model=gpt-4o').expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });

  it('T8: filters by tags — must have ALL supplied tags', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [t1] = await ingest(agent, [
      { tags: ['prod', 'nl'], spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);
    const [t2] = await ingest(agent, [
      { tags: ['prod'], spans: [{ spanId: 's2', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);

    const both = await agent.get('/api/v1/traces?tags=prod&tags=nl').expect(200);
    expect(both.body.data.map((t: { id: string }) => t.id)).toEqual([t1]);

    const one = await agent.get('/api/v1/traces?tags=prod').expect(200);
    expect(one.body.data.map((t: { id: string }) => t.id).sort()).toEqual([t1, t2].sort());
  });

  it('T8: filters by metadata — must contain every supplied key/value pair', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    const [t1] = await ingest(agent, [
      {
        metadata: { env: 'prod', lang: 'nl' },
        spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now) }],
      },
    ]);
    await ingest(agent, [
      { metadata: { env: 'prod' }, spans: [{ spanId: 's2', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces?metadata[env]=prod&metadata[lang]=nl').expect(200);
    expect(res.body.data.map((t: { id: string }) => t.id)).toEqual([t1]);
  });

  it('T8: tags/metadata filters are team-scoped', async () => {
    const { agent } = await authedAgent(app);
    const other = await authedAgent(app);
    const now = new Date();
    await ingest(other.agent, [
      { tags: ['prod'], spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces?tags=prod').expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('T8: list rows include tags', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    await ingest(agent, [
      { tags: ['prod'], spans: [{ spanId: 's1', name: 'step', kind: 'llm', startTime: iso(now) }] },
    ]);

    const res = await agent.get('/api/v1/traces').expect(200);
    expect(res.body.data[0].tags).toEqual(['prod']);
  });

  it('min_score/rule_id filters only return traces that rule scored at or above the threshold', async () => {
    const { agent, teamId } = await authedAgent(app);
    const now = new Date();
    const judgeModel = await registerTestModel(agent);
    const rule = await agent.post('/api/v1/eval-rules').send({ name: 'quality', criteria: 'helpful', judgeModel }).expect(201);
    const ruleId = rule.body.id;

    const [traceAId] = await ingest(agent, [
      { name: 'scored-high', spans: [{ spanId: 's1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    await ingest(agent, [
      { name: 'unscored', spans: [{ spanId: 's2', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);

    // `spanId` on EvalRuleScore is a bare scalar with no FK (see
    // online-eval-rule.test.ts), so reusing the trace's own id as a stand-in
    // span id is fine for this filter-only arrangement.
    await prisma.evalRuleScore.create({
      data: { teamId, ruleId, traceId: traceAId, spanId: traceAId, score: 90 },
    });

    const res = await agent.get(`/api/v1/traces?min_score=80&rule_id=${ruleId}`).expect(200);
    expect(res.body.data.map((t: { id: string }) => t.id)).toEqual([traceAId]);
    expect(res.body.total).toBe(1);
  });

  it('never matches another team eval_rule_scores row via the min_score/rule_id EXISTS filter (cross-tenant score leak)', async () => {
    const a = await authedAgent(app);
    const now = new Date();
    const aJudgeModel = await registerTestModel(a.agent);
    const aRule = await a.agent
      .post('/api/v1/eval-rules')
      .send({ name: 'quality', criteria: 'helpful', judgeModel: aJudgeModel })
      .expect(201);
    const ruleId = aRule.body.id;
    const [traceAId] = await ingest(a.agent, [
      { name: 'a-run', spans: [{ spanId: 'a1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }] },
    ]);
    await prisma.evalRuleScore.create({
      data: { teamId: a.teamId, ruleId, traceId: traceAId, spanId: traceAId, score: 95 },
    });

    const b = await authedAgent(app);
    const res = await b.agent.get(`/api/v1/traces?min_score=80&rule_id=${ruleId}`).expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });
});

/**
 * A trace whose spans all succeeded is green in the list, and until now that stayed true
 * even when the gateway had to fall back to a different model to get that success. The
 * filter `warning:yes` could find such a run, but only if someone already suspected it
 * existed. Carrying the flag on the row is what puts it in front of a reader who does not.
 */
describe('GET /api/v1/traces — warnings on the list row', () => {
  it('flags a green trace whose span carries a warning', async () => {
    const { agent } = await authedAgent(app);
    const now = new Date();
    await ingest(agent, [
      {
        name: 'rescued-by-fallback',
        spans: [
          {
            spanId: 'w1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now),
            attributes: {
              warning: { type: 'model_fallback', message: 'backup-model answered instead.' },
            },
          },
        ],
      },
    ]);
    await ingest(agent, [
      {
        name: 'clean-run',
        spans: [{ spanId: 'c1', name: 'gpt-4o', kind: 'llm', status: 'ok', startTime: iso(now) }],
      },
    ]);

    const res = await agent.get('/api/v1/traces').expect(200);
    const byName = Object.fromEntries(
      (res.body.data as { name: string; status: string; hasWarning: boolean }[]).map((t) => [t.name, t]),
    );
    expect(byName['rescued-by-fallback'].status).toBe('ok');
    expect(byName['rescued-by-fallback'].hasWarning).toBe(true);
    expect(byName['clean-run'].hasWarning).toBe(false);
  });
});
