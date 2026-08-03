import { UnrecoverableError } from 'bullmq';
import { EmailRepository } from './email.repository';
import { EmailService } from './email.service';
import type { EmailJobData } from './email.queue';
import { EmailPermanentError } from './email.types';

const service = new EmailService(new EmailRepository());

/**
 * Worker entry point for one email job.
 *
 * Converts `EmailPermanentError` into BullMQ's `UnrecoverableError` so the job
 * fails immediately instead of burning five attempts on an address that will
 * never accept mail. Every other error propagates unchanged and is retried.
 *
 * @param data - The job payload.
 * @throws {UnrecoverableError} On a permanent transport failure.
 * @throws {Error} On a transient failure, so BullMQ retries.
 */
export async function processEmail(data: EmailJobData): Promise<void> {
  try {
    await service.deliver(data);
  } catch (err) {
    if (err instanceof EmailPermanentError) {
      throw new UnrecoverableError(err.message);
    }
    throw err;
  }
}
