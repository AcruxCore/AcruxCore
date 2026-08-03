import { createApp } from '../../app';
import prisma from '../shared/db/client';
import { authedAgent } from '../test-utils';
import { EmailRepository } from './email.repository';
import { EmailPermanentError } from './email.types';
import { loadEmailConfig, resetEmailConfig } from './email.config';
import { resolveTransport, resetTransport } from './email.transport';
import { MemoryTransport } from './memory.transport';
import { SesTransport, type SesClientLike } from './ses.transport';
import { EmailService } from './email.service';
import { drainEmailQueue, getEmailQueue, toEmailJobId } from './email.queue';
import { getMemoryTransport } from './memory.transport';
import type { EmailPayload } from './email.types';
import { getRedisConnection } from '../evaluations/queue/connection';

const app = createApp();
const repo = new EmailRepository();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE
    email_log, team_invites, audit_log, api_keys,
    team_members, teams, users
  RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('EmailRepository', () => {
  it('records a queued attempt and settles it as sent', async () => {
    const owner = await authedAgent(app, { email: 'owner@emaillog.test' });

    const { id } = await repo.create({
      teamId: owner.teamId,
      type: 'team_invite',
      toEmail: 'invitee@example.com',
      subject: 'You have been invited',
    });

    const queued = await repo.findById(id);
    expect(queued?.status).toBe('queued');
    expect(queued?.sentAt).toBeNull();
    expect(queued?.providerMessageId).toBeNull();

    await repo.markSent(id, 'ses-message-id-1');

    const sent = await repo.findById(id);
    expect(sent?.status).toBe('sent');
    expect(sent?.providerMessageId).toBe('ses-message-id-1');
    expect(sent?.sentAt).toBeInstanceOf(Date);
  });

  it('truncates a failure reason to 1000 characters', async () => {
    const owner = await authedAgent(app, { email: 'owner@emailfail.test' });
    const { id } = await repo.create({
      teamId: owner.teamId,
      type: 'team_invite',
      toEmail: 'invitee@example.com',
      subject: 'Subject',
    });

    await repo.markFailed(id, 'x'.repeat(5000));

    const row = await repo.findById(id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toHaveLength(1000);
  });

  it('counts only this team\'s rows of this type inside the window', async () => {
    const a = await authedAgent(app, { email: 'a@emailcount.test' });
    const b = await authedAgent(app, { email: 'b@emailcount.test' });

    for (let i = 0; i < 3; i++) {
      await repo.create({
        teamId: a.teamId,
        type: 'team_invite',
        toEmail: `x${i}@example.com`,
        subject: 'S',
      });
    }
    await repo.create({
      teamId: b.teamId,
      type: 'team_invite',
      toEmail: 'other@example.com',
      subject: 'S',
    });

    expect(await repo.countRecent(a.teamId, 'team_invite', 3_600_000)).toBe(3);
    expect(await repo.countRecent(b.teamId, 'team_invite', 3_600_000)).toBe(1);
  });

  it('excludes rows older than the window', async () => {
    const owner = await authedAgent(app, { email: 'owner@emailwindow.test' });
    const { id } = await repo.create({
      teamId: owner.teamId,
      type: 'team_invite',
      toEmail: 'old@example.com',
      subject: 'S',
    });
    // Backdate past the window. Raw SQL because `created_at` has a DB default
    // and is not part of the Prisma create input we use in production code.
    await prisma.$executeRaw`UPDATE email_log SET created_at = now() - interval '2 hours' WHERE id = ${id}::uuid`;

    expect(await repo.countRecent(owner.teamId, 'team_invite', 3_600_000)).toBe(0);
  });

  it('cascades away with its team', async () => {
    const owner = await authedAgent(app, { email: 'owner@emailcascade.test' });
    const { id } = await repo.create({
      teamId: owner.teamId,
      type: 'team_invite',
      toEmail: 'x@example.com',
      subject: 'S',
    });

    await prisma.$executeRaw`DELETE FROM teams WHERE id = ${owner.teamId}::uuid`;

    expect(await repo.findById(id)).toBeNull();
  });
});

describe('email config', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    resetEmailConfig();
    resetTransport();
  });

  it('defaults to the memory transport and the documented from/reply-to', () => {
    resetEmailConfig();
    delete process.env.EMAIL_TRANSPORT;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_REPLY_TO;
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'development';

    const config = loadEmailConfig();
    expect(config.transport).toBe('memory');
    expect(config.from).toBe('acruxcore <no-reply@acruxcore.com>');
    expect(config.replyTo).toBe('support@acruxcore.com');
    expect(config.appUrl).toBe('http://localhost:5173');
  });

  it('rejects EMAIL_TRANSPORT=ses without credentials', () => {
    resetEmailConfig();
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_TRANSPORT = 'ses';
    delete process.env.SES_REGION;
    delete process.env.SES_ACCESS_KEY_ID;
    delete process.env.SES_SECRET_ACCESS_KEY;

    expect(() => loadEmailConfig()).toThrow(/SES_REGION/);
  });

  it('rejects a non-URL APP_URL', () => {
    resetEmailConfig();
    process.env.NODE_ENV = 'development';
    process.env.APP_URL = 'acruxcore.com';

    expect(() => loadEmailConfig()).toThrow(/Invalid email configuration/);
  });

  it('forces the memory transport in test env even when ses is configured', () => {
    resetEmailConfig();
    resetTransport();
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_TRANSPORT = 'ses';
    process.env.SES_REGION = 'eu-central-1';
    process.env.SES_ACCESS_KEY_ID = 'AKIAFAKE';
    process.env.SES_SECRET_ACCESS_KEY = 'secret';

    expect(resolveTransport()).toBeInstanceOf(MemoryTransport);
  });

  it('drops a transport cached outside test env once NODE_ENV becomes test, with no reset', () => {
    resetEmailConfig();
    resetTransport();
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_TRANSPORT = 'ses';
    process.env.SES_REGION = 'eu-central-1';
    process.env.SES_ACCESS_KEY_ID = 'AKIAFAKE';
    process.env.SES_SECRET_ACCESS_KEY = 'secret';
    process.env.APP_URL = 'https://acruxcore.com';

    expect(resolveTransport()).toBeInstanceOf(SesTransport);

    // No resetTransport() call here on purpose: the memo would still hold the
    // SesTransport above if the test-env check ran after the cache read.
    process.env.NODE_ENV = 'test';

    expect(resolveTransport()).toBeInstanceOf(MemoryTransport);
  });
});

describe('MemoryTransport', () => {
  it('collects messages, reports them, and resets', async () => {
    const t = new MemoryTransport();
    const message = {
      to: 'a@example.com',
      from: 'acruxcore <no-reply@acruxcore.com>',
      subject: 'S',
      html: '<p>hi</p>',
      text: 'hi',
    };

    const res = await t.send(message);
    expect(res.providerMessageId).toBe('memory-1');
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0].to).toBe('a@example.com');

    t.reset();
    expect(t.sent()).toHaveLength(0);
  });

  it('throws the armed failure until disarmed', async () => {
    const t = new MemoryTransport();
    t.failWith(new EmailPermanentError('nope'));
    await expect(
      t.send({ to: 'a@b.c', from: 'f', subject: 'S', html: 'h', text: 't' }),
    ).rejects.toBeInstanceOf(EmailPermanentError);

    t.failWith(null);
    await expect(
      t.send({ to: 'a@b.c', from: 'f', subject: 'S', html: 'h', text: 't' }),
    ).resolves.toEqual({ providerMessageId: 'memory-1' });
  });
});

describe('SesTransport error classification', () => {
  const config = {
    transport: 'ses' as const,
    sesRegion: 'eu-central-1',
    sesAccessKeyId: 'AKIAFAKE',
    sesSecretAccessKey: 'secret',
    from: 'acruxcore <no-reply@acruxcore.com>',
    replyTo: 'support@acruxcore.com',
    appUrl: 'https://acruxcore.com',
  };
  const message = {
    to: 'a@example.com',
    from: config.from,
    replyTo: config.replyTo,
    subject: 'S',
    html: '<p>hi</p>',
    text: 'hi',
  };

  /** Builds a fake SES client that always rejects with the given error. */
  function failingClient(err: unknown): SesClientLike {
    return { send: async () => Promise.reject(err) };
  }

  it('returns the provider message id on success', async () => {
    const t = new SesTransport(config, { send: async () => ({ MessageId: 'ses-1' }) });
    await expect(t.send(message)).resolves.toEqual({ providerMessageId: 'ses-1' });
  });

  it('maps extra headers into SES\'s Simple content', async () => {
    let sent: { input?: Record<string, unknown> } | undefined;
    const t = new SesTransport(config, {
      send: async (command) => {
        sent = command as { input?: Record<string, unknown> };
        return { MessageId: 'ses-headers' };
      },
    });

    await t.send({
      ...message,
      headers: {
        'List-Unsubscribe': '<https://acruxcore.com/api/v1/email/unsubscribe?token=abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    const simple = (sent!.input as { Content: { Simple: { Headers?: { Name: string; Value: string }[] } } })
      .Content.Simple;
    expect(simple.Headers).toEqual([
      {
        Name: 'List-Unsubscribe',
        Value: '<https://acruxcore.com/api/v1/email/unsubscribe?token=abc>',
      },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]);
  });

  it('omits Headers entirely when a template sets none', async () => {
    let sent: { input?: Record<string, unknown> } | undefined;
    const t = new SesTransport(config, {
      send: async (command) => {
        sent = command as { input?: Record<string, unknown> };
        return { MessageId: 'ses-no-headers' };
      },
    });

    await t.send(message);

    // Not an empty array — SES treats an empty `Headers` list as malformed.
    const simple = (sent!.input as { Content: { Simple: { Headers?: unknown } } }).Content.Simple;
    expect(simple.Headers).toBeUndefined();
  });

  it('classifies MessageRejected as permanent', async () => {
    const err = Object.assign(new Error('Email address is not verified'), {
      name: 'MessageRejected',
    });
    const t = new SesTransport(config, failingClient(err));
    await expect(t.send(message)).rejects.toBeInstanceOf(EmailPermanentError);
  });

  it('classifies AccountSuspendedException as permanent', async () => {
    const err = Object.assign(new Error('suspended'), { name: 'AccountSuspendedException' });
    const t = new SesTransport(config, failingClient(err));
    await expect(t.send(message)).rejects.toBeInstanceOf(EmailPermanentError);
  });

  it('lets ThrottlingException through as retryable', async () => {
    const err = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    const t = new SesTransport(config, failingClient(err));
    await expect(t.send(message)).rejects.not.toBeInstanceOf(EmailPermanentError);
  });

  it('treats a 5xx as retryable and an unnamed 4xx as permanent', async () => {
    const server = Object.assign(new Error('boom'), {
      name: 'InternalFailure',
      $metadata: { httpStatusCode: 500 },
    });
    await expect(
      new SesTransport(config, failingClient(server)).send(message),
    ).rejects.not.toBeInstanceOf(EmailPermanentError);

    const client = Object.assign(new Error('bad request'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
    });
    await expect(
      new SesTransport(config, failingClient(client)).send(message),
    ).rejects.toBeInstanceOf(EmailPermanentError);
  });
});

describe('EmailService enqueue → deliver', () => {
  const service = new EmailService(repo);
  const transport = getMemoryTransport();

  /** Template payload used by these tests. */
  function payload(): EmailPayload {
    return {
      type: 'team_invite',
      props: {
        teamName: 'Acme Research',
        inviterName: 'Dana Ops',
        role: 'editor',
        inviteUrl: 'https://acruxcore.com/invite/tok123',
        expiresAt: '2026-08-01T09:30:00.000Z',
      },
    };
  }

  beforeEach(async () => {
    transport.reset();
    // Leftover jobs from a previous test would be drained into this one.
    await getEmailQueue().obliterate({ force: true });
  });

  afterAll(async () => {
    await getEmailQueue().close();
    // `getEmailQueue()` was constructed with the SHARED `getRedisConnection()`
    // ioredis instance, not one of its own — closing the Queue does not quit a
    // caller-supplied connection (mirrors `run-engine.test.ts`'s afterAll for
    // the same reason). Without this, the open socket keeps the Jest process
    // alive after every test in the file has finished.
    await getRedisConnection().quit();
  });

  it('writes a queued row, then delivers and marks it sent', async () => {
    const owner = await authedAgent(app, { email: 'owner@enqueue.test' });

    const logId = await service.enqueue({
      teamId: owner.teamId,
      to: 'invitee@example.com',
      payload: payload(),
      dedupeKey: 'invite:enqueue-1',
    });
    expect(logId).not.toBeNull();

    const queued = await repo.findById(logId!);
    expect(queued?.status).toBe('queued');
    expect(queued?.subject).toBe('Dana Ops invited you to Acme Research on acruxcore');

    expect(await drainEmailQueue()).toBe(1);

    const sent = await repo.findById(logId!);
    expect(sent?.status).toBe('sent');
    expect(sent?.providerMessageId).toMatch(/^memory-/);

    const [message] = transport.sent();
    expect(message.to).toBe('invitee@example.com');
    expect(message.from).toBe('acruxcore <no-reply@acruxcore.com>');
    expect(message.replyTo).toBe('support@acruxcore.com');
    expect(message.html).toContain('https://acruxcore.com/invite/tok123');
    expect(message.text).toContain('https://acruxcore.com/invite/tok123');
  });

  it('enqueues once for a repeated dedupe key', async () => {
    const owner = await authedAgent(app, { email: 'owner@dedupe.test' });

    const first = await service.enqueue({
      teamId: owner.teamId,
      to: 'invitee@example.com',
      payload: payload(),
      dedupeKey: 'invite:dedupe-1',
    });
    const second = await service.enqueue({
      teamId: owner.teamId,
      to: 'invitee@example.com',
      payload: payload(),
      dedupeKey: 'invite:dedupe-1',
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await prisma.emailLog.count({ where: { teamId: owner.teamId } })).toBe(1);

    expect(await drainEmailQueue()).toBe(1);
    expect(transport.sent()).toHaveLength(1);
  });

  it('marks the row failed and reports a permanent error unretryably', async () => {
    const owner = await authedAgent(app, { email: 'owner@permfail.test' });
    transport.failWith(new EmailPermanentError('address suppressed'));

    const logId = await service.enqueue({
      teamId: owner.teamId,
      to: 'bounce@example.com',
      payload: payload(),
      dedupeKey: 'invite:permfail-1',
    });

    await expect(
      service.deliver({
        emailLogId: logId!,
        teamId: owner.teamId,
        to: 'bounce@example.com',
        payload: payload(),
      }),
    ).rejects.toBeInstanceOf(EmailPermanentError);

    const row = await repo.findById(logId!);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('address suppressed');

    const { processEmail } = await import('./email.processor');
    await expect(
      processEmail({
        emailLogId: logId!,
        teamId: owner.teamId,
        to: 'bounce@example.com',
        payload: payload(),
      }),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });

    transport.failWith(null);
  });

  it('never persists the invite token', async () => {
    const owner = await authedAgent(app, { email: 'owner@notoken.test' });
    const logId = await service.enqueue({
      teamId: owner.teamId,
      to: 'invitee@example.com',
      payload: payload(),
      dedupeKey: 'invite:notoken-1',
    });
    await drainEmailQueue();

    const row = await repo.findById(logId!);
    expect(JSON.stringify(row)).not.toContain('tok123');
  });

  it('marks the row failed (not left queued) when config loading throws inside deliver', async () => {
    const owner = await authedAgent(app, { email: 'owner@configfail.test' });

    const logId = await service.enqueue({
      teamId: owner.teamId,
      to: 'invitee@example.com',
      payload: payload(),
      dedupeKey: 'invite:configfail-1',
    });
    expect(logId).not.toBeNull();

    // Force `loadEmailConfig()` to throw on the very next call, simulating a
    // config (or, equivalently, a template-render) failure reached from
    // inside `deliver()` — this must settle the row as `failed`, not leave it
    // `queued` through every retry.
    const savedAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'not-a-url';
    resetEmailConfig();
    try {
      await expect(
        service.deliver({
          emailLogId: logId!,
          teamId: owner.teamId,
          to: 'invitee@example.com',
          payload: payload(),
        }),
      ).rejects.toThrow(/Invalid email configuration/);
    } finally {
      process.env.APP_URL = savedAppUrl;
      resetEmailConfig();
    }

    const row = await repo.findById(logId!);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('Invalid email configuration');
  });

  it('resolves a genuine concurrent race to exactly one surviving row and job', async () => {
    const owner = await authedAgent(app, { email: 'owner@concurrent.test' });

    // Both calls race `queue.getJob()` before either reaches `queue.add()` —
    // the sequential case (one call fully finishes before the next starts) is
    // already covered by 'enqueues once for a repeated dedupe key' above, and
    // takes an entirely different path through `enqueue()` (the fast-path
    // `getJob` check short-circuits it). `Promise.all` is what actually
    // exercises the loser-deletes-its-own-row branch.
    const [first, second] = await Promise.all([
      service.enqueue({
        teamId: owner.teamId,
        to: 'invitee@example.com',
        payload: payload(),
        dedupeKey: 'invite:race-1',
      }),
      service.enqueue({
        teamId: owner.teamId,
        to: 'invitee@example.com',
        payload: payload(),
        dedupeKey: 'invite:race-1',
      }),
    ]);

    // Exactly one call won: the other got null back (either from the
    // fast-path check, if BullMQ happened to serialize the two `add`s far
    // enough apart, or from the loser-deletes-its-row branch if it didn't).
    const winners = [first, second].filter((id) => id !== null);
    expect(winners).toHaveLength(1);

    expect(await prisma.emailLog.count({ where: { teamId: owner.teamId } })).toBe(1);

    const [row] = await prisma.emailLog.findMany({ where: { teamId: owner.teamId } });
    expect(row.status).toBe('queued');

    expect(await drainEmailQueue()).toBe(1);
    expect(transport.sent()).toHaveLength(1);

    const settled = await repo.findById(row.id);
    expect(settled?.status).toBe('sent');
  });

  // Redis and Postgres are settled separately, so a job routinely outlives the
  // row it points at: a restored database snapshot, a test database truncated
  // while sharing the dev Redis, a manually replayed job. This used to be worse
  // than cosmetic — `markSent` threw P2025, the throw became the failure the
  // catch block handled, `markFailed` threw on the same missing row, and the
  // rethrow told BullMQ to retry a message the transport had already accepted.
  it('does not resend an email whose email_log row vanished before it settled', async () => {
    const owner = await authedAgent(app, { email: 'owner@stalejob.test' });

    const logId = await service.enqueue({
      teamId: owner.teamId,
      to: 'invitee@example.com',
      payload: payload(),
      dedupeKey: 'invite:stale-row',
    });
    expect(logId).not.toBeNull();

    // Whatever the job pointed at is gone by the time the worker picks it up.
    await prisma.emailLog.delete({ where: { id: logId! } });

    // The drain must not throw, and BullMQ must see the job as done — a failure
    // here is what caused the duplicate sends.
    expect(await drainEmailQueue()).toBe(1);
    expect(transport.sent()).toHaveLength(1);
    expect(await prisma.emailLog.count({ where: { teamId: owner.teamId } })).toBe(0);
  });

  it('settling a vanished row is a no-op, not a throw, on both paths', async () => {
    const owner = await authedAgent(app, { email: 'owner@gonerow.test' });
    const { id } = await repo.create({
      teamId: owner.teamId,
      type: 'team_invite',
      toEmail: 'invitee@example.com',
      subject: 'Subject',
    });
    await prisma.emailLog.delete({ where: { id } });

    // False rather than a P2025 throw, so the caller can log one line instead of
    // a stack trace per retry.
    await expect(repo.markSent(id, 'ses-message-id-gone')).resolves.toBe(false);
    await expect(repo.markFailed(id, 'transport exploded')).resolves.toBe(false);
  });
});

describe('toEmailJobId', () => {
  it('is deterministic for the same dedupeKey', () => {
    expect(toEmailJobId('invite:abc123')).toBe(toEmailJobId('invite:abc123'));
  });

  it('never collides two different keys a naive : -> _ substitution would', () => {
    // `invite:a_b` and `invite_a:b` both become `invite_a_b` under a plain
    // `:` -> `_` replace — the exact collision `toEmailJobId`'s hash suffix
    // exists to rule out.
    const a = toEmailJobId('invite:a_b');
    const b = toEmailJobId('invite_a:b');
    expect(a).not.toBe(b);
  });

  it('never contains a colon and is never a bare integer', () => {
    const id = toEmailJobId('invite:abc123');
    expect(id).not.toContain(':');
    expect(Number.isNaN(Number(id))).toBe(true);
  });
});
