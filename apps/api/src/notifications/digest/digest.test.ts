import { Prisma } from '@prisma/client';
import { createApp } from '../../../app';
import prisma from '../../shared/db/client';
import { addUserToTeam, authedAgent, type AuthedAgent } from '../../test-utils';
import { drainEmailQueue, getEmailQueue } from '../../email/email.queue';
import { getMemoryTransport } from '../../email/memory.transport';
import type { EmailMessage } from '../../email/email.types';
import { DigestRepository } from './digest.repository';
import { DigestService } from './digest.service';
import { getDigestQueue, digestJobId } from './digest.queue';
import { isoWeekKey } from './digest.format';
import { processDigest } from './digest.processor';
import { DIGEST_DISPATCH_JOB, DIGEST_TEAM_JOB } from './digest.queue';

const app = createApp();
const service = new DigestService(new DigestRepository());

/** Dispatch time every test reasons from, so windows are deterministic. */
const NOW = new Date('2026-07-27T08:00:00.000Z');
/** The window `NOW` implies: 2026-07-20T08:00Z (inclusive) → 2026-07-27T08:00Z (exclusive). */
const WINDOW = DigestService.windows(NOW).current;

/** A day inside the current window. */
const INSIDE = new Date('2026-07-23T12:00:00.000Z');
/** A day inside the preceding window, for delta assertions. */
const PRIOR = new Date('2026-07-16T12:00:00.000Z');

/**
 * Inserts a gateway request at a chosen time. Raw SQL because `created_at` has a
 * database default and is not part of the Prisma create input production code uses.
 */
async function seedRequest(
  teamId: string,
  at: Date,
  costUsd: number,
  model = 'gpt-4o-mini',
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO gateway_requests
      (team_id, requested_model, status, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
    VALUES (${teamId}::uuid, ${model}, 'success', 10, 5, 15, ${new Prisma.Decimal(costUsd)}, ${at})`;
}

/** Inserts a trace at a chosen time. */
async function seedTrace(teamId: string, at: Date, name = 'agent run'): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO traces (team_id, name, started_at, created_at)
    VALUES (${teamId}::uuid, ${name}, ${at}, ${at})`;
}

/** Delivers everything queued and returns the accepted messages. */
async function flush(): Promise<EmailMessage[]> {
  await drainEmailQueue();
  return getMemoryTransport().sent();
}

/** The one digest message, asserting there is exactly one. */
async function theDigest(): Promise<EmailMessage> {
  const messages = await flush();
  expect(messages).toHaveLength(1);
  return messages[0];
}

beforeEach(async () => {
  await getEmailQueue().obliterate({ force: true });
  await getDigestQueue().obliterate({ force: true });
  await prisma.$executeRaw`TRUNCATE TABLE
    eval_results, experiment_runs, experiments, dataset_examples, datasets,
    span_payloads, spans, traces, budgets, gateway_requests,
    gateway_model_fallbacks, gateway_models, virtual_keys, provider_connections,
    prompt_tool_bindings, prompt_aliases, prompt_versions, prompts,
    notification_preferences, email_log, audit_log, api_keys,
    team_members, teams, users
  RESTART IDENTITY CASCADE`;
  getMemoryTransport().reset();
});

describe('digest eligibility', () => {
  it('includes a team with gateway activity in the window', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 1);

    expect(await new DigestRepository().findActiveTeamIds(WINDOW)).toEqual([owner.teamId]);
  });

  it('includes a team whose only activity is a trace', async () => {
    const owner = await authedAgent(app);
    await seedTrace(owner.teamId, INSIDE);

    expect(await new DigestRepository().findActiveTeamIds(WINDOW)).toEqual([owner.teamId]);
  });

  it('skips a dormant team entirely — no job, no email', async () => {
    const dormant = await authedAgent(app);

    const dispatched = await service.dispatch(NOW);

    expect(dispatched).toBe(0);
    expect(await getDigestQueue().getJobCountByTypes('waiting')).toBe(0);
    expect(await flush()).toHaveLength(0);
    expect(await prisma.emailLog.count({ where: { teamId: dormant.teamId } })).toBe(0);
  });

  it('excludes activity just outside the window and includes activity just inside', async () => {
    const outside = await authedAgent(app);
    const inside = await authedAgent(app);

    // One millisecond before the inclusive lower bound.
    await seedRequest(outside.teamId, new Date(WINDOW.from.getTime() - 1), 1);
    // Exactly on the inclusive lower bound.
    await seedRequest(inside.teamId, WINDOW.from, 1);

    expect(await new DigestRepository().findActiveTeamIds(WINDOW)).toEqual([inside.teamId]);
  });

  it('excludes activity at the exclusive upper bound', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, WINDOW.to, 1);

    expect(await new DigestRepository().findActiveTeamIds(WINDOW)).toEqual([]);
  });
});

describe('digest content', () => {
  it('reports spend, request count, traces, and run counts for the window', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 4.25);
    await seedRequest(owner.teamId, INSIDE, 1.75);
    await seedTrace(owner.teamId, INSIDE);
    await seedTrace(owner.teamId, INSIDE);
    await seedTrace(owner.teamId, INSIDE);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    const digest = await theDigest();

    expect(digest.to).toBe(owner.email);
    expect(digest.text).toContain('$6.00'); // 4.25 + 1.75
    expect(digest.text).toContain('Gateway requests: 2');
    expect(digest.text).toContain('Traces recorded: 3');
    // The header states the days the window actually covers — the upper bound is
    // exclusive, so the last covered day is the one before it.
    expect(digest.text).toContain('2026-07-20');
    expect(digest.text).toContain('2026-07-26');
  });

  it('orders top models by spend and caps the list at five', async () => {
    const owner = await authedAgent(app);
    for (const [model, cost] of [
      ['model-a', 1],
      ['model-b', 6],
      ['model-c', 2],
      ['model-d', 5],
      ['model-e', 3],
      ['model-f', 4],
    ] as const) {
      await seedRequest(owner.teamId, INSIDE, cost, model);
    }

    const top = await new DigestRepository().topModels(owner.teamId, WINDOW, 5);

    expect(top).toHaveLength(5);
    expect(top.map((m) => m.model)).toEqual([
      'model-b',
      'model-d',
      'model-f',
      'model-e',
      'model-c',
    ]);
    // The cheapest model is the one dropped, not an arbitrary one.
    expect(top.map((m) => m.model)).not.toContain('model-a');
  });

  it('computes week-over-week deltas against the preceding window', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, PRIOR, 10);
    await seedRequest(owner.teamId, INSIDE, 12);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    const digest = await theDigest();

    expect(digest.text).toContain('+20% vs last week');
  });

  it('renders no NaN or Infinity when the prior window was empty', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 3);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    const digest = await theDigest();

    expect(digest.text).toContain('new this week');
    expect(digest.text).not.toMatch(/NaN|Infinity/);
    expect(digest.html).not.toMatch(/NaN|Infinity/);
  });

  it('reports budget standing against the cap', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 1);
    await owner.agent
      .post('/api/v1/gateway/budgets')
      .send({ virtualKeyId: null, period: 'month', limitUsd: 50 })
      .expect(201);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    const digest = await theDigest();

    expect(digest.text).toContain('Team-wide (month)');
    expect(digest.text).toContain('of $50.00');
  });

  it('contains no prompt text, trace payload, or eval output', async () => {
    const owner = await authedAgent(app);
    const SECRET_PROMPT = 'PROMPT-SECRET-do-not-mail-me';
    const SECRET_TRACE = 'TRACE-SECRET-do-not-mail-me';

    // A real prompt with a real committed version, whose template body is secret.
    const prompt = await owner.agent
      .post('/api/v1/prompts')
      .send({ name: 'digest-privacy' })
      .expect(201);
    const version = await owner.agent
      .post(`/api/v1/prompts/${prompt.body.id}/versions`)
      .send({ messages: [{ role: 'system', content: SECRET_PROMPT }] })
      .expect(201);
    // Backdate it into the window, the same way `seedRequest`/`seedTrace` do. The API sets
    // `created_at` to the real clock, and `WINDOW` is a fixed range ending 2026-07-27T08:00Z,
    // so on any later date the row fell outside it and `Versions committed` counted 0 — the
    // assertion below failed purely because time had passed since this test was written.
    await prisma.$executeRaw`
      UPDATE prompt_versions SET created_at = ${INSIDE} WHERE id = ${version.body.id}::uuid`;

    // A real trace whose name is secret, plus gateway activity so the team qualifies.
    await seedTrace(owner.teamId, INSIDE, SECRET_TRACE);
    await seedRequest(owner.teamId, INSIDE, 2);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    const digest = await theDigest();

    expect(digest.text).not.toContain(SECRET_PROMPT);
    expect(digest.html).not.toContain(SECRET_PROMPT);
    expect(digest.text).not.toContain(SECRET_TRACE);
    expect(digest.html).not.toContain(SECRET_TRACE);
    // The counts are still there — it reports that activity happened, not what it was.
    expect(digest.text).toContain('Versions committed: 1');
    expect(digest.text).toContain('Traces recorded: 1');
  });
});

describe('one-click unsubscribe headers', () => {
  it('sends the RFC 8058 header pair pointing at the recipient own token', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 1);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    const digest = await theDigest();

    // A footer link alone does not satisfy Gmail/Yahoo's bulk-sender requirement.
    expect(digest.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const header = digest.headers?.['List-Unsubscribe'];
    expect(header).toMatch(/^<https?:\/\/.*\/api\/v1\/email\/unsubscribe\?token=.+>$/);

    // The header and the visible footer link must carry the same token, or one of
    // the two ways a recipient can unsubscribe would not work.
    const fromHeader = new URL(header!.slice(1, -1)).searchParams.get('token');
    const fromBody = new URL(
      digest.text.match(/https?:\/\/\S*unsubscribe\S*/)![0],
    ).searchParams.get('token');
    expect(fromHeader).toBe(fromBody);
  });
});

describe('digest recipients', () => {
  it('goes to owners and admins, not editors or viewers', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    const editor = await addUserToTeam(app, owner.teamId, 'editor');
    const viewer = await addUserToTeam(app, owner.teamId, 'viewer');
    await seedRequest(owner.teamId, INSIDE, 1);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));

    const recipients = (await flush()).map((m) => m.to).sort();
    expect(recipients).toEqual([admin.email, owner.email].sort());
    expect(recipients).not.toContain(editor.email);
    expect(recipients).not.toContain(viewer.email);
  });

  it('skips a user who disabled weekly_digest, and still mails their teammates', async () => {
    const owner = await authedAgent(app);
    const admin = await addUserToTeam(app, owner.teamId, 'admin');
    await seedRequest(owner.teamId, INSIDE, 1);
    await owner.agent
      .patch('/api/v1/notifications/preferences')
      .send({ category: 'weekly_digest', enabled: false })
      .expect(200);

    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));

    expect((await flush()).map((m) => m.to)).toEqual([admin.email]);
  });
});

describe('digest scheduling', () => {
  it('enqueues one job per active team, keyed by team and ISO week', async () => {
    const active = await authedAgent(app);
    await authedAgent(app); // dormant — must not get a job
    await seedRequest(active.teamId, INSIDE, 1);

    const dispatched = await service.dispatch(NOW);

    expect(dispatched).toBe(1);
    const job = await getDigestQueue().getJob(digestJobId(active.teamId, isoWeekKey(NOW)));
    expect(job).toBeDefined();
    expect(job!.name).toBe(DIGEST_TEAM_JOB);
  });

  it('dispatching twice for the same ISO week yields one job, and one email', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 1);

    await service.dispatch(NOW);
    // A worker restart, a double schedule registration, or a manual re-dispatch.
    await service.dispatch(new Date(NOW.getTime() + 3_600_000));

    expect(await getDigestQueue().getJobCountByTypes('waiting')).toBe(1);

    // Run the single job that survived; one email, not two.
    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    await service.send(owner.teamId, WINDOW, isoWeekKey(NOW));
    expect(await flush()).toHaveLength(1);
  });

  it('the dispatch processor fans out, and the team processor sends', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 7.5);

    await processDigest(DIGEST_DISPATCH_JOB, {}, NOW);

    const job = await getDigestQueue().getJob(digestJobId(owner.teamId, isoWeekKey(NOW)));
    expect(job).toBeDefined();

    await processDigest(DIGEST_TEAM_JOB, job!.data, NOW);
    const digest = await theDigest();
    expect(digest.text).toContain('$7.50');
  });

  it('rejects an unknown job name rather than silently doing nothing', async () => {
    await expect(processDigest('digest-something-else', {}, NOW)).rejects.toThrow(
      'Unknown digest job name',
    );
  });

  it('sends nothing for a team that was deleted between dispatch and send', async () => {
    const owner = await authedAgent(app);
    await seedRequest(owner.teamId, INSIDE, 1);
    await prisma.$executeRaw`DELETE FROM teams WHERE id = ${owner.teamId}::uuid`;

    expect(await service.send(owner.teamId, WINDOW, isoWeekKey(NOW))).toBe(0);
    expect(await flush()).toHaveLength(0);
  });
});
