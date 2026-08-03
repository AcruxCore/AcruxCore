import { loadEmailConfig } from './email.config';
import { getMemoryTransport } from './memory.transport';
import { SesTransport } from './ses.transport';
import { SmtpTransport } from './smtp.transport';
import { EmailPermanentError, type EmailMessage } from './email.types';

/** A provider-agnostic outbound email sender. */
export interface EmailTransport {
  /**
   * Delivers one message.
   *
   * @param message - Fully rendered recipient/subject/html/text.
   * @returns The provider's message id, for correlating with provider logs.
   * @throws {EmailPermanentError} The message can never succeed (malformed
   *   address, suppressed recipient) — the caller must not retry.
   * @throws {Error} Any transient failure (throttling, 5xx); safe to retry.
   */
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

let cached: EmailTransport | null = null;

/**
 * Picks the transport for this process.
 *
 * `NODE_ENV === 'test'` forces `MemoryTransport` **unconditionally**, ignoring
 * `EMAIL_TRANSPORT` — a test must never be able to spend money or email a real
 * person, whatever the environment happens to hold. This check runs *before*
 * the memo read (not after), so the guarantee depends on the current
 * environment rather than on which call happened to populate the cache first:
 * a `SesTransport` cached earlier while `NODE_ENV` was not `'test'` must not
 * survive `NODE_ENV` later becoming `'test'` without a `resetTransport()` in
 * between. `getMemoryTransport()` is itself memoized, so this still returns
 * the one shared instance tests assert against.
 *
 * @returns The memoized transport, or the shared `MemoryTransport` when
 *   `NODE_ENV === 'test'`.
 * @throws {Error} When the configuration is invalid.
 */
export function resolveTransport(): EmailTransport {
  if (process.env.NODE_ENV === 'test') return getMemoryTransport();

  if (cached) return cached;

  const config = loadEmailConfig();
  switch (config.transport) {
    case 'memory':
      cached = getMemoryTransport();
      break;
    case 'smtp':
      cached = new SmtpTransport(config);
      break;
    case 'ses':
      cached = new SesTransport(config);
      break;
    case 'none':
      cached = new DisabledTransport();
      break;
  }
  return cached;
}

/**
 * Last line of defence for `EMAIL_TRANSPORT=none`.
 *
 * Callers are supposed to check {@link isEmailDisabled} and never enqueue, so
 * reaching this class means a job outlived a config change — a queue drained
 * after the operator switched email off. Failing permanently (rather than
 * retrying five times, or silently reporting success) leaves one honest
 * `email_log` row explaining why nothing arrived.
 */
class DisabledTransport implements EmailTransport {
  /**
   * @throws {EmailPermanentError} Always — there is no transport to deliver with.
   */
  async send(_message: EmailMessage): Promise<{ providerMessageId: string }> {
    throw new EmailPermanentError(
      'EMAIL_TRANSPORT=none — this deployment does not send email.',
    );
  }
}

/** Drops the memoized transport so a test can re-resolve. */
export function resetTransport(): void {
  cached = null;
}
