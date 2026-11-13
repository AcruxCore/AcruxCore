import { getOnlineEvalQueue } from './online-eval.queue';
import type { OnlineEvalJobData } from './online-eval.queue';

/**
 * Fire-and-forget: enqueues one online-eval job and returns immediately.
 * Synchronous by contract — callers must never `await` this — and it must
 * never throw: an unscored trace is a missing score, but a thrown error here
 * would fail the user's own request. Callers are responsible for calling
 * this only for `llm` spans (this function does no kind check itself, so it
 * stays a pure "enqueue what I was told" primitive both call sites can trust
 * identically).
 *
 * The job is named after the span ({@link onlineEvalJobId}), so a span queued twice
 * while its first job is still held by BullMQ collapses into one job and one set of
 * judge calls.
 *
 * @param args - The ids the worker reads everything else from.
 * @returns Nothing; an enqueue failure is logged, never thrown.
 */
export function enqueueOnlineEval(args: OnlineEvalJobData): void {
  try {
    getOnlineEvalQueue()
      .add('score', args, { jobId: onlineEvalJobId(args.spanId) })
      .catch((err) => console.error('[online-eval] enqueue failed', err));
  } catch (err) {
    console.error('[online-eval] enqueue failed', err);
  }
}

/**
 * The BullMQ job id of a span's online-eval job: one job per span, whatever path
 * queued it.
 *
 * A hyphen joins the parts on purpose. BullMQ 5 refuses a custom id containing `:`
 * ("Custom Id cannot contain :"), and {@link enqueueOnlineEval} only logs a refused
 * add, so a colon here would silently stop every online-eval job.
 *
 * @param spanId - The span row's id (a UUID).
 * @returns `online-eval-<spanId>`.
 */
export function onlineEvalJobId(spanId: string): string {
  return `online-eval-${spanId}`;
}
