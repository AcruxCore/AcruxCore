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
 */
export function enqueueOnlineEval(args: OnlineEvalJobData): void {
  try {
    getOnlineEvalQueue()
      .add('score', args)
      .catch((err) => console.error('[online-eval] enqueue failed', err));
  } catch (err) {
    console.error('[online-eval] enqueue failed', err);
  }
}
