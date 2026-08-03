import { isEmailDisabled, loadEmailConfig } from './email.config';
import { EmailRepository } from './email.repository';
import { resolveTransport } from './email.transport';
import { renderEmail } from './templates';
import type { EmailJobData } from './email.queue';
import { emailJobOpts, getEmailQueue, toEmailJobId } from './email.queue';
import type { EmailPayload } from './email.types';

/** What a caller needs to supply to send one email. */
export interface EnqueueEmailInput {
  /** Team the email belongs to — NOT NULL on `email_log`, for RLS. */
  teamId: string;
  /** Single recipient address. */
  to: string;
  /** Template key + props. */
  payload: EmailPayload;
  /**
   * Deterministic idempotency key, used verbatim as the BullMQ `jobId` — e.g.
   * `invite:<inviteId>`. A retried request or a double-clicked button produces
   * the same key, and BullMQ keeps one job.
   */
  dedupeKey: string;
}

/**
 * Sends product email: enqueue at the call site, deliver in the worker.
 *
 * Nothing sends inside an HTTP request. Creating an invite must not fail
 * because SES hiccuped — the invite row and its link are valid either way.
 */
export class EmailService {
  constructor(private readonly repo: EmailRepository) {}

  /**
   * Records a queued attempt and adds its job.
   *
   * The template is rendered here purely to obtain the subject for the
   * `email_log` row (and to fail loudly on the request path if a template is
   * broken); the rendered bodies are discarded, and the worker renders again
   * from the same pure function. The body is never persisted — it carries the
   * invite token.
   *
   * @param input - Team, recipient, payload, idempotency key.
   * @returns The `email_log` row id, or null when nothing was enqueued — either
   *   because a job with this `dedupeKey` already exists, or because this
   *   deployment has no mail transport at all ({@link isEmailDisabled}). Callers
   *   that count enqueued mail cannot tell the two apart, and should not need to:
   *   both mean no new message.
   */
  async enqueue(input: EnqueueEmailInput): Promise<string | null> {
    // A deployment with no transport short-circuits before touching Redis or
    // `email_log`. Queueing here would only produce a `failed` row a self-hoster
    // can do nothing about — and it would give every no-email install a Redis
    // dependency on paths (invites, member changes) that otherwise need none.
    if (isEmailDisabled()) return null;

    const queue = getEmailQueue();
    // Sanitized once and reused for both the lookup and the add, so a
    // dedupeKey containing a colon (the natural `invite:<inviteId>` shape)
    // dedupes correctly instead of throwing — see `toEmailJobId`'s docstring.
    const jobId = toEmailJobId(input.dedupeKey);

    // Fast path: check first so a duplicate request that arrives well after an
    // earlier one has already been enqueued does not write a second, doomed
    // `email_log` row for a job BullMQ will refuse to add.
    const existing = await queue.getJob(jobId);
    if (existing) return null;

    const { subject } = renderEmail(input.payload);
    const { id } = await this.repo.create({
      teamId: input.teamId,
      type: input.payload.type,
      toEmail: input.to,
      subject,
    });

    await queue.add(
      input.payload.type,
      { emailLogId: id, teamId: input.teamId, to: input.to, payload: input.payload },
      { ...emailJobOpts, jobId },
    );

    // BullMQ does NOT throw on an already-existing jobId: internally,
    // `addStandardJob-9.lua` checks `EXISTS jobIdKey` and, if it already does,
    // routes to `handleDuplicatedJob` — which returns the jobId string and
    // otherwise leaves Redis's stored job (the FIRST caller's data) untouched.
    // The fast-path check above only catches the sequential case (a job
    // already existed when we checked); it cannot catch the genuine race — two
    // concurrent `enqueue()` calls for the same dedupeKey, both passing that
    // check before either reaches `add`.
    //
    // Crucially, the `Job` object `queue.add()` itself returns is NOT
    // authoritative for detecting this: BullMQ's JS wrapper constructs that
    // `Job` instance (and its `.data`) from the CALLER's own local payload
    // *before* talking to Redis (see `Job.create`/`Scripts.addJob` — the add
    // script only ever returns the jobId string, win or lose), so
    // `job.data.emailLogId` always equals `id` and can never reveal a loss.
    // The only way to learn who actually landed in Redis is a genuine re-read:
    // `queue.getJob()` does a fresh `Job.fromId` fetch, which returns whichever
    // caller's data Redis actually kept. If that isn't `id`, this call lost the
    // race, and its `email_log` row must be deleted — otherwise it would sit
    // at `queued` forever, since no job on the queue references it and no
    // worker will ever settle it.
    const stored = await queue.getJob(jobId);
    if (stored?.data.emailLogId !== id) {
      await this.repo.deleteById(id);
      return null;
    }

    return id;
  }

  /**
   * Renders and sends one job, then settles its `email_log` row.
   *
   * A transient failure marks the row `failed` and rethrows so BullMQ retries;
   * a later successful attempt overwrites the row as `sent`. So `failed` means
   * "the latest attempt failed", not "never delivered".
   *
   * `loadEmailConfig()` and `renderEmail()` run **inside** this try block on
   * purpose: either can throw (a bad env var, a template bug), and if that
   * throw happened before the row was touched, the row would stay `queued`
   * through every one of BullMQ's retries and the eventual permanent failure —
   * silently, since nothing else ever revisits a `queued` row. Settling it
   * `failed` here is what lets an operator (or a test) see that the send never
   * happened.
   *
   * A job whose `email_log` row has vanished settles as a warning, not an error.
   * That case used to be genuinely damaging rather than merely noisy: `markSent`
   * threw, its throw became the `err` this catch block handles, `markFailed`
   * threw on the same missing row, and the rethrow handed BullMQ a failure for a
   * message the transport had already accepted — so every retry sent the email
   * again.
   *
   * @param data - The job payload.
   * @throws {EmailPermanentError} When the transport says no retry can help.
   * @throws {Error} On any transient failure, or on a config/template error.
   */
  async deliver(data: EmailJobData): Promise<void> {
    try {
      const config = loadEmailConfig();
      const rendered = renderEmail(data.payload);

      const { providerMessageId } = await resolveTransport().send({
        to: data.to,
        from: config.from,
        replyTo: config.replyTo,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: rendered.headers,
      });
      if (!(await this.repo.markSent(data.emailLogId, providerMessageId))) {
        console.warn(
          `[EmailService] sent an email whose email_log row ${data.emailLogId} no longer exists — stale or replayed job`,
        );
      }
    } catch (err) {
      try {
        const settled = await this.repo.markFailed(
          data.emailLogId,
          err instanceof Error ? err.message : String(err),
        );
        if (!settled) {
          console.warn(
            `[EmailService] email_log row ${data.emailLogId} no longer exists — stale or replayed job`,
          );
        }
      } catch (markFailedErr) {
        // A DB blip while recording the failure must not mask the original
        // transport/config/template error — log it and rethrow the original
        // so BullMQ's retry/error-classification logic still sees the real
        // cause.
        console.error(
          `[EmailService] failed to record failure on email_log ${data.emailLogId}`,
          markFailedErr,
        );
      }
      throw err;
    }
  }
}

/**
 * Builds an absolute link for an email body.
 *
 * The server has no `window.location.origin`, so every link in an email is
 * built from `APP_URL`.
 *
 * @param path - Absolute in-app path, e.g. `/invite/abc`.
 * @returns The absolute URL.
 */
export function appLink(path: string): string {
  const base = loadEmailConfig().appUrl.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
