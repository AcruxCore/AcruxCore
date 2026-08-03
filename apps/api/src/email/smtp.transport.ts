import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailConfig } from './email.config';
import { EmailPermanentError, type EmailMessage } from './email.types';
import type { EmailTransport } from './email.transport';

/**
 * SMTP codes that mean "this address or message will never be accepted".
 *
 * Retrying these burns BullMQ's five attempts and 75 seconds of backoff on a
 * message no retry can fix, so they are converted to {@link EmailPermanentError}.
 * `450`/`451`/`452` are deliberately absent — they are transient by definition.
 */
const PERMANENT_CODES = new Set([500, 501, 502, 503, 504, 510, 511, 512, 513, 523, 550, 551, 552, 553, 554]);

/**
 * Generic SMTP delivery via nodemailer — the self-host counterpart to
 * {@link SesTransport}.
 *
 * Exists because the SES transport speaks the AWS API, which is useless to
 * someone running this on their own box with Postfix, Mailgun, or Fastmail. Both
 * satisfy the same {@link EmailTransport} contract, so nothing above the
 * transport layer knows which one is live.
 */
export class SmtpTransport implements EmailTransport {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly replyTo?: string;

  /**
   * @param config - Validated config; `smtpHost` and `smtpPort` are guaranteed
   *   present by `loadEmailConfig()`'s refine for `EMAIL_TRANSPORT=smtp`.
   * @throws {Error} If the host or port is missing, which would mean the config
   *   guard was bypassed.
   */
  constructor(config: EmailConfig) {
    if (!config.smtpHost || !config.smtpPort) {
      throw new Error('SmtpTransport requires SMTP_HOST and SMTP_PORT.');
    }
    this.from = config.from;
    this.replyTo = config.replyTo;
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure ?? false,
      // Omit `auth` entirely for an unauthenticated relay: passing
      // `{ user: undefined }` makes nodemailer attempt AUTH and fail.
      auth:
        config.smtpUser && config.smtpPassword
          ? { user: config.smtpUser, pass: config.smtpPassword }
          : undefined,
    });
  }

  /**
   * Delivers one message over SMTP.
   *
   * @param message - Fully rendered recipient/subject/html/text plus any extra
   *   headers (RFC 8058 one-click unsubscribe on the digest).
   * @returns The `Message-ID` the server assigned, for correlating with its logs.
   * @throws {EmailPermanentError} On a 5xx reply — the address or message is
   *   rejected outright and no retry will help.
   * @throws {Error} On any transient failure (connection reset, 4xx, timeout).
   */
  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    try {
      const info = await this.transporter.sendMail({
        to: message.to,
        from: message.from || this.from,
        replyTo: message.replyTo ?? this.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      });
      return { providerMessageId: info.messageId ?? '' };
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      if (code && PERMANENT_CODES.has(code)) {
        throw new EmailPermanentError(
          `SMTP rejected the message permanently (${code}): ${(err as Error).message}`,
        );
      }
      throw err;
    }
  }
}
