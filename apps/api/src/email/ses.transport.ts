import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { EmailConfig } from './email.config';
import { EmailPermanentError, type EmailMessage } from './email.types';
import type { EmailTransport } from './email.transport';

/**
 * The slice of `SESv2Client` this transport uses. Narrowing it to one method
 * lets a test inject a fake and assert error classification without a network
 * call or AWS credentials.
 */
export interface SesClientLike {
  send(command: unknown): Promise<{ MessageId?: string }>;
}

/** AWS error names that no retry can fix. */
const PERMANENT_ERROR_NAMES = new Set([
  'MessageRejected',
  'AccountSuspendedException',
  'SendingPausedException',
  'MailFromDomainNotVerifiedException',
]);

/** AWS error names that are normal operation and must be retried. */
const TRANSIENT_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'LimitExceededException',
]);

/**
 * Decides whether an AWS failure is worth retrying.
 *
 * Names are checked first because they are the precise signal; the HTTP status
 * is the fallback, where any 4xx other than 429 means "we sent something AWS
 * will never accept" and every 5xx means "try again".
 *
 * @param err - The error thrown by the SES client.
 * @returns True when the send can never succeed.
 */
function isPermanent(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  if (PERMANENT_ERROR_NAMES.has(name)) return true;
  if (TRANSIENT_ERROR_NAMES.has(name)) return false;

  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
}

/** Sends through AWS SES v2. */
export class SesTransport implements EmailTransport {
  private readonly client: SesClientLike;

  /**
   * @param config - Validated email config; supplies region and credentials.
   * @param client - Injectable client, for tests. Defaults to a real
   *   `SESv2Client` built from `config`.
   */
  constructor(
    private readonly config: EmailConfig,
    client?: SesClientLike,
  ) {
    this.client =
      client ??
      new SESv2Client({
        region: config.sesRegion,
        credentials: {
          accessKeyId: config.sesAccessKeyId!,
          secretAccessKey: config.sesSecretAccessKey!,
        },
      });
  }

  /**
   * Delivers one message via `SendEmail`.
   *
   * @param message - The rendered message.
   * @returns SES's message id, for correlating with SES logs.
   * @throws {EmailPermanentError} When the failure can never succeed.
   * @throws {Error} On any transient failure, so BullMQ retries it.
   */
  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const command = new SendEmailCommand({
      FromEmailAddress: message.from,
      Destination: { ToAddresses: [message.to] },
      ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            Text: { Data: message.text, Charset: 'UTF-8' },
          },
          // RFC 8058 one-click unsubscribe rides here. Omitted entirely rather
          // than sent as an empty array when a template sets no headers, since
          // SES treats an empty `Headers` list as a malformed request.
          Headers: message.headers
            ? Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value }))
            : undefined,
        },
      },
    });

    try {
      const out = await this.client.send(command);
      return { providerMessageId: out.MessageId ?? '' };
    } catch (err) {
      const name = (err as { name?: string })?.name ?? 'Error';
      const detail = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        throw new EmailPermanentError(`SES rejected the message (${name}): ${detail}`);
      }
      throw err;
    }
  }
}
