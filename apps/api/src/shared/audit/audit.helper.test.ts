import request from 'supertest';
import { createApp } from '../../../app';
import prisma from '../db/client';
import { signupTestUserWithApiKey } from '../../test-utils';
import { settleAuditWrites } from './index';

const app = createApp();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE secrets, audit_log, api_keys, team_members, teams, users RESTART IDENTITY CASCADE`;
});

describe('audit writes', () => {
  it('outlive the response, and settleAuditWrites waits for them', async () => {
    const { apiKey } = await signupTestUserWithApiKey(app);

    // Hold a SHARE lock on audit_log from another connection: it blocks every
    // insert into the table until this transaction ends, which keeps the
    // fire-and-forget audit write in flight for as long as the test needs.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE audit_log IN SHARE MODE`;
      locked();
      await released;
    }, { timeout: 30_000 });
    await isLocked;

    // The mutation succeeds while its audit row is still waiting to be written.
    await request(app).post('/api/v1/secrets').set('Authorization', `Bearer ${apiKey}`)
      .send({ name: 'K', value: 'aaaa1111' }).expect(201);
    expect(await prisma.auditLog.count({ where: { event: 'secret_created' } })).toBe(0);

    // settleAuditWrites must not resolve while that write is still pending.
    const settled = settleAuditWrites().then(() => 'settled');
    const early = await Promise.race([settled, new Promise((r) => setTimeout(() => r('pending'), 200))]);
    expect(early).toBe('pending');

    release();
    await holder;
    await expect(settled).resolves.toBe('settled');
    expect(await prisma.auditLog.count({ where: { event: 'secret_created' } })).toBe(1);
  });
});
