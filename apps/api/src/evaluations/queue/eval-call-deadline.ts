import { positiveIntFromEnv } from '../../shared/env';

/**
 * Optional ceiling (ms) on one evaluation model call — an eval cell, a run's judge
 * call, or an online-eval rule's judge call — retries and fallbacks included.
 *
 * Unset by default: an eval call runs under the gateway's own chain deadline
 * (`GATEWAY_CHAIN_DEADLINE_MS`, 90 s) like every other call, so a slow but healthy
 * judge or reasoning model is not cut off early. Fairness between teams on the shared
 * worker slots comes from the per-team slot cap (`withTeamSlot`), not from this: a
 * team whose upstream is slow holds only its own share of the slots. An operator who
 * wants slots freed sooner sets `EVAL_CALL_DEADLINE_MS`; it can only shorten the
 * gateway's deadline, never extend it.
 *
 * Read on every call, so a test or an operator restart can change it.
 *
 * @returns `EVAL_CALL_DEADLINE_MS` when it is a positive whole number, else `undefined`
 *   (no deadline beyond the gateway's own); a set but unusable value is warned about.
 */
export function evalCallDeadlineMs(): number | undefined {
  return positiveIntFromEnv('EVAL_CALL_DEADLINE_MS');
}
