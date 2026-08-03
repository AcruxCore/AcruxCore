import { closeRedisConnection } from '../evaluations/queue/connection';
import { closeEmailQueue } from '../email/email.queue';
import { closeDigestQueue } from '../notifications/digest/digest.queue';
import { closeRateLimitRedis } from '../shared/auth/rate-limit.storage';
import prisma from '../shared/db/client';

/**
 * Global test teardown, wired in via `setupFilesAfterEnv`.
 *
 * Spec B put `notify()` inside ordinary business operations — removing a member,
 * finalizing a run, recording gateway spend — so a suite that never mentions
 * email now opens a BullMQ queue and its Redis socket anyway. An open socket is a
 * live handle, and Jest reports "did not exit one second after the test run has
 * completed" and then hangs forever, which reads as a broken test run even though
 * every assertion passed.
 *
 * Registering the hook here rather than in a `globalTeardown` module is
 * deliberate: `globalTeardown` runs in its own module registry, so it would see
 * fresh `null` singletons and close nothing. `setupFilesAfterEnv` shares the test
 * file's registry, which is where the live instances actually are.
 *
 * Every closer is a no-op when its singleton was never created, so a pure-logic
 * suite gains no Redis or Postgres dependency from this file. Suites that already
 * close these themselves still work — the closers are idempotent, and these hooks
 * run last (outermost `afterAll`).
 */
afterAll(async () => {
  await closeEmailQueue();
  await closeDigestQueue();
  await closeRedisConnection();
  await closeRateLimitRedis();
  await prisma.$disconnect();
});
