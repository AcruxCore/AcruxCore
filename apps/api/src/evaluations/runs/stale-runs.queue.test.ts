import {
  getStaleRunsQueue,
  closeStaleRunsQueue,
  registerStaleRunSchedule,
  REAP_STALE_RUNS_JOB,
} from './stale-runs.queue';

afterEach(async () => {
  // Leave no repeatable job behind for the next test in this file.
  const queue = getStaleRunsQueue();
  for (const entry of await queue.getRepeatableJobs()) {
    await queue.removeRepeatableByKey(entry.key);
  }
});

afterAll(async () => {
  await closeStaleRunsQueue();
});

async function sweepJobs() {
  return (await getStaleRunsQueue().getRepeatableJobs()).filter((j) => j.name === REAP_STALE_RUNS_JOB);
}

describe('registerStaleRunSchedule', () => {
  it('enabled: false registers nothing and returns false', async () => {
    expect(await registerStaleRunSchedule({ enabled: false, cron: '*/10 * * * *' })).toBe(false);
    expect(await sweepJobs()).toHaveLength(0);
  });

  it('enabled: true registers exactly one repeatable job on the given cron pattern', async () => {
    expect(await registerStaleRunSchedule({ enabled: true, cron: '*/10 * * * *' })).toBe(true);

    const jobs = await sweepJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].pattern).toBe('*/10 * * * *');
  });

  it('re-registering with a different cron replaces the old schedule, and disabling removes it', async () => {
    await registerStaleRunSchedule({ enabled: true, cron: '*/10 * * * *' });
    await registerStaleRunSchedule({ enabled: true, cron: '*/5 * * * *' });
    const jobs = await sweepJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].pattern).toBe('*/5 * * * *');

    await registerStaleRunSchedule({ enabled: false, cron: '*/5 * * * *' });
    expect(await sweepJobs()).toHaveLength(0);
  });
});
