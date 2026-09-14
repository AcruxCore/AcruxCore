import { EmailPermanentError, type EmailMessage } from './email.types';
import type { EmailTransport } from './email.transport';

/**
 * Whether this process may hand a message to a real mail provider.
 *
 * Production always may. Anywhere else it is an explicit opt-in, because the
 * transport is chosen from `EMAIL_TRANSPORT` alone and a developer's `.env`
 * routinely holds the production SMTP credentials — so a worker booted on a
 * laptop would mail every team in whatever database it happens to point at
 * (issue #415). Falling back to the memory transport prints what would have
 * been sent instead, which is what a developer wanted in the first place.
 *
 * Set `EMAIL_ALLOW_REAL_DELIVERY=true` to send for real from a non-production
 * process — testing an invite or a digest against a live inbox.
 *
 * @returns True in production, or when the opt-in is set.
 */
export function isRealDeliveryAllowed(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.EMAIL_ALLOW_REAL_DELIVERY === 'true'
  );
}

/** Domains reserved by RFC 2606/6761 that can never accept mail. */
const RESERVED_SUFFIXES = ['.invalid', '.test', '.example', '.localhost'];
const RESERVED_EXACT = new Set([
  'invalid',
  'test',
  'example',
  'localhost',
  'example.com',
  'example.net',
  'example.org',
]);

/**
 * Whether an address can only ever hard-bounce.
 *
 * Every provider rejects RFC 2606/6761 reserved domains, and a sustained bounce
 * rate is what gets a sending identity throttled or suspended — so one run
 * against a database full of `@example.com` fixtures can degrade deliverability
 * for real customers, with nothing linking the two events.
 *
 * @param address - The recipient address, any case.
 * @returns True when the domain is reserved, or the address has no domain at all.
 */
export function isReservedRecipient(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at === -1) return true;

  // A trailing dot is a legal fully-qualified form (`example.com.`) and must not
  // let an address slip past the exact-match set.
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '');
  if (!domain) return true;
  if (RESERVED_EXACT.has(domain)) return true;
  return (
    RESERVED_SUFFIXES.some((suffix) => domain.endsWith(suffix)) ||
    domain.endsWith('.example.com') ||
    domain.endsWith('.example.net') ||
    domain.endsWith('.example.org')
  );
}

/**
 * Wraps a real transport and drops anything addressed to a reserved domain.
 *
 * Applied to `smtp` and `ses` only — the memory transport is what tests and
 * local development use, and every fixture in the suite is an `@example.com`
 * address, so guarding it would break the thing it is there to exercise.
 *
 * Failing permanently (rather than reporting success) leaves one honest
 * `email_log` row saying the message was never sent, instead of a `sent` row
 * for a message that in fact bounced.
 */
export class ReservedDomainGuard implements EmailTransport {
  /**
   * @param inner - The provider transport that does the actual delivery. Public
   *   so a caller can report which provider is live without unwrapping by hand.
   */
  constructor(public readonly inner: EmailTransport) {}

  /**
   * Delivers one message unless its recipient domain is reserved.
   *
   * @param message - Fully rendered recipient/subject/html/text.
   * @returns Whatever the wrapped transport returns.
   * @throws {EmailPermanentError} When the recipient domain can only bounce.
   */
  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    if (isReservedRecipient(message.to)) {
      throw new EmailPermanentError(
        `Refusing to send to ${message.to}: reserved domain (RFC 2606/6761) can only hard-bounce.`,
      );
    }
    return this.inner.send(message);
  }
}
