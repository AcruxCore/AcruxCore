import { ProviderError } from '../providers/adapter';

/**
 * Settles with `work`, or rejects with a retriable timeout `ProviderError` the moment
 * `deadline` aborts — whichever comes first.
 *
 * The provider call is given the same signal, and normally stops on it. This race is
 * the guarantee for when it does not: undici ignores an abort while a TCP connect is
 * still in progress, so a provider whose address drops packets held the call for the
 * full 10 s connect timeout. Measured on the real stack, that ran a 90 s chain to
 * 94.7 s, close to Cloudflare's 100 s limit (issue #732). The losing call is not
 * leaked: its signal has already aborted, so undici ends it as soon as the connect
 * settles, and its late result or error is dropped here.
 *
 * @param work - The provider call in flight.
 * @param deadline - The chain's deadline signal for this attempt.
 * @returns What `work` resolved with, when it settled first.
 * @throws {ProviderError} 504 `timeout`, retriable, when the deadline passed first;
 *   otherwise whatever `work` rejected with.
 */
export function raceDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  // A late rejection from the losing call must not surface as an unhandled one.
  work.catch(() => undefined);
  if (deadline.aborted) return Promise.reject(deadlineError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(deadlineError());
    deadline.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        deadline.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        deadline.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function deadlineError(): ProviderError {
  return new ProviderError('Gateway call ran out of time before the provider answered', 504, 'timeout', true);
}
