import {
  getRetentionQueue,
  closeRetentionQueue,
  registerRetentionSchedule,
  RETENTION_PURGE_JOB,
} from './retention.queue';

afterEach(async () => {
  // Leave no repeatable job behind for the next test in this file.
  const queue = getRetentionQueue();
  for (const entry of await queue.getRepeatableJobs()) {
    await queue.removeRepeatableByKey(entry.key);
  }
});

afterAll(async () => {
  await closeRetentionQueue();
});

describe('registerRetentionSchedule', () => {
  it('enabled: false registers nothing and returns false', async () => {
    const registered = await registerRetentionSchedule({ enabled: false, cron: '0 3 * * *' });
    expect(registered).toBe(false);
    const jobs = await getRetentionQueue().getRepeatableJobs();
    expect(jobs.filter((j) => j.name === RETENTION_PURGE_JOB)).toHaveLength(0);
  });

  it('enabled: true registers exactly one repeatable job on the given cron pattern', async () => {
    const registered = await registerRetentionSchedule({ enabled: true, cron: '0 3 * * *' });
    expect(registered).toBe(true);

    const jobs = await getRetentionQueue().getRepeatableJobs();
    const purgeJobs = jobs.filter((j) => j.name === RETENTION_PURGE_JOB);
    expect(purgeJobs).toHaveLength(1);
    expect(purgeJobs[0].pattern).toBe('0 3 * * *');
  });

  it('re-registering with a different cron replaces the old schedule rather than adding a second one', async () => {
    await registerRetentionSchedule({ enabled: true, cron: '0 3 * * *' });
    await registerRetentionSchedule({ enabled: true, cron: '0 4 * * *' });

    const jobs = await getRetentionQueue().getRepeatableJobs();
    const purgeJobs = jobs.filter((j) => j.name === RETENTION_PURGE_JOB);
    expect(purgeJobs).toHaveLength(1);
    expect(purgeJobs[0].pattern).toBe('0 4 * * *');
  });
});
