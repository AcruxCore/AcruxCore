import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks the async call tree of a first-run claim.
 *
 * Better Auth's sign-up behaviour is configured once, per instance — there is no
 * per-call "this account is already trusted, skip verification" switch. The
 * claim needs exactly that: it creates an account whose address is proven by
 * possession of the server's own log, so demanding an email round-trip would
 * both send a pointless message and leave the owner unable to sign in on an
 * install with no mail transport.
 *
 * An `AsyncLocalStorage` rather than a module-level boolean because the
 * callbacks that must read it (`user.create.before`,
 * `emailVerification.sendVerificationEmail`) are invoked by Better Auth from
 * inside the sign-up call, and one of them may be run without being awaited. A
 * plain flag cleared in a `finally` could therefore be gone before the callback
 * reads it; an ALS store is bound at call time and cannot be seen by any other
 * request.
 */
const claimStore = new AsyncLocalStorage<true>();

/**
 * Runs `fn` marked as a first-run claim.
 *
 * @param fn - The sign-up call to make on the claimer's behalf.
 * @returns Whatever `fn` resolves to.
 */
export function runAsFirstRunClaim<T>(fn: () => Promise<T>): Promise<T> {
  return claimStore.run(true, fn);
}

/**
 * Whether the current async context belongs to a first-run claim.
 *
 * @returns True only inside {@link runAsFirstRunClaim}.
 */
export function isFirstRunClaim(): boolean {
  return claimStore.getStore() === true;
}
