import { getAuth } from '../../shared/auth/better-auth';
import { loadAuthConfig } from '../../shared/auth/auth.config';
import { appLink } from '../../email/email.service';
import { AuthRepository } from '../auth.repository';
import { ForbiddenError } from '../../shared/errors';
import { runAsFirstRunClaim } from './claim-context';
import { CLAIM_TTL_MS, mintClaimToken, verifyClaimToken } from './first-run.token';

/**
 * Serializes claim attempts within this process.
 *
 * The "is this instance unclaimed?" check and the account creation that
 * invalidates it are two steps, so two simultaneous requests could both pass the
 * check. A self-hosted install runs one API process, which makes an in-process
 * queue sufficient; a promise chain is also the only option, since account
 * creation goes through Better Auth and cannot join our transaction.
 */
let claimChain: Promise<unknown> = Promise.resolve();

/**
 * The first-run claim flow: how a self-hosted instance with no email transport
 * gets its first administrator.
 */
export class FirstRunService {
  constructor(private readonly repo: AuthRepository) {}

  /**
   * True when this instance has no accounts and claiming is permitted.
   *
   * @returns Whether a claim URL should be offered.
   */
  async isUnclaimed(): Promise<boolean> {
    if (!loadAuthConfig().allowFirstRunClaim) return false;
    return (await this.repo.countUsers()) === 0;
  }

  /**
   * Prints a single-use claim URL to the log when the instance is unclaimed.
   *
   * A URL and never a generated password: logs get shipped to aggregators and
   * kept long after the deploy, so a password there outlives the machine, while a
   * token that dies on first use (and within the hour) is a far cheaper thing to
   * leak. Nothing is printed on an already-claimed instance, so a restart does
   * not hand out a fresh way in.
   */
  async printClaimUrlIfUnclaimed(): Promise<void> {
    if (!(await this.isUnclaimed())) return;
    const url = appLink(`/first-run?token=${mintClaimToken()}`);
    const minutes = CLAIM_TTL_MS / 60_000;
    console.log(
      [
        '',
        '  ┌─────────────────────────────────────────────────────────────────┐',
        '  │  acruxcore is not set up yet.                                   │',
        '  │  Open this link to create the first account (owner):            │',
        '  └─────────────────────────────────────────────────────────────────┘',
        '',
        `  ${url}`,
        '',
        `  The link works once and expires in ${minutes} minutes.`,
        '  Restart the server to get a new one.',
        '',
      ].join('\n'),
    );
  }

  /**
   * Creates the first account from a valid claim token.
   *
   * The account is marked verified without an email round-trip: this path exists
   * precisely for installs that cannot send mail, and demanding verification would
   * lock the owner out of the instance they just installed. That is safe here in a
   * way it would not be for open signup, because possession of the claim token
   * already proves access to the server's own logs.
   *
   * @param input - The claim token plus the credentials to create. The email is
   *   lowercased to match how Better Auth stores it.
   * @returns The `Set-Cookie` headers Better Auth issued, so the caller is signed
   *   in immediately, and the new user's id.
   * @throws {ForbiddenError} If the token is invalid/expired, claiming is
   *   disabled, or the instance already has an account. All three share one
   *   message — a distinct "already claimed" reply would confirm to a stranger
   *   that this host runs acruxcore.
   */
  async claim(input: {
    token: string;
    email: string;
    password: string;
    displayName?: string;
    /**
     * The claiming request's own forwarding headers and user-agent, passed
     * through so the session Better Auth creates belongs to the browser that is
     * claiming — and resolves to the same address its next sign-in will.
     */
    device?: { cfConnectingIp?: string; forwardedFor?: string; userAgent?: string };
  }): Promise<{ setCookie: string[]; userId: string }> {
    const run = async (): Promise<{ setCookie: string[]; userId: string }> => {
      if (!verifyClaimToken(input.token) || !(await this.isUnclaimed())) {
        throw new ForbiddenError('This link is no longer valid.');
      }

      // Better Auth lowercases the address before storing it, so everything
      // downstream — the sign-in below, any later lookup — must use the same
      // form. A raw `Owner@Example.com` would create the account (claiming the
      // instance and killing the token) and then fail to find its own row.
      const email = input.email.toLowerCase();

      // Only the two device headers are forwarded, never the whole request:
      // this call runs server-side but on the claimer's behalf, and without them
      // the session records a null IP and user-agent. `known_devices` would then
      // hold a phantom "first device" nobody ever used, and the owner's next
      // real sign-in — the same browser, seconds later — would look new and
      // trigger an unrecognised-device alert.
      const headers = new Headers({
        ...(input.device?.userAgent ? { 'user-agent': input.device.userAgent } : {}),
        ...(input.device?.cfConnectingIp
          ? { 'cf-connecting-ip': input.device.cfConnectingIp }
          : {}),
        ...(input.device?.forwardedFor
          ? { 'x-forwarded-for': input.device.forwardedFor }
          : {}),
      });

      // Through Better Auth rather than a direct insert, so the password is
      // hashed by the same code path every later login verifies against, and the
      // `user.create.after` hook provisions the owner's team. Wrapped in the
      // claim marker so the `user.create.before` hook records the address as
      // verified and no confirmation email goes out.
      const res = await runAsFirstRunClaim(() =>
        getAuth().api.signUpEmail({
          body: {
            email,
            password: input.password,
            name: input.displayName ?? email,
          },
          headers,
          asResponse: true,
        }),
      );

      if (!res.ok) {
        const body = await res.text();
        throw new ForbiddenError(`Could not create the first account: ${body}`);
      }

      const created = (await res.json()) as { user?: { id?: string } };
      const userId = created.user?.id;
      if (!userId) {
        throw new ForbiddenError('Could not create the first account.');
      }

      // Better Auth skips auto sign-in whenever verification is required, which
      // on an install with a mail transport would hand the owner a 201 carrying
      // no cookie — the claim page would then bounce them straight to a login
      // form on the instance they just set up. The account is already verified
      // by this point, so signing in explicitly is the same path a returning
      // owner takes.
      let setCookie = res.headers.getSetCookie?.() ?? [];
      if (setCookie.length === 0) {
        const signIn = await getAuth().api.signInEmail({
          body: { email, password: input.password },
          headers,
          asResponse: true,
        });
        setCookie = signIn.ok ? (signIn.headers.getSetCookie?.() ?? []) : [];
      }

      return { setCookie, userId };
    };

    // Chain onto any in-flight claim, and keep the chain alive on failure so a
    // rejected attempt does not poison later ones.
    const result = claimChain.then(run, run);
    claimChain = result.catch(() => undefined);
    return result;
  }
}
