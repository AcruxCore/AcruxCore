/**
 * Thrown by the run finalizer while a run still has answers to produce or to judge.
 *
 * It is a "poll again" signal, not a failure: the finalize job catches it and waits.
 * It carries the run's progress, so the caller can tell a slow run (the counts keep
 * rising) from a stuck one (they do not) — the first must never be failed for being
 * slow. It has no HTTP status because it never reaches a client.
 */
export class RunNotReadyError extends Error {
  /**
   * @param runId - The run being finalized.
   * @param produced - Answers written so far, errored ones included.
   * @param judged - Answers that are settled: scored, given a judge reason, or errored.
   * @param expected - Answers the run will have when complete (grid × examples).
   */
  constructor(
    readonly runId: string,
    readonly produced: number,
    readonly judged: number,
    readonly expected: number,
  ) {
    super(`Run ${runId} not ready to finalize: cell/judge jobs still in flight (${judged} of ${expected} results judged)`);
    this.name = 'RunNotReadyError';
  }
}
