import type { Me, TeamMembership } from './types';
import { api } from './client';

/**
 * Identity endpoints. Credentials themselves are handled by Better Auth's own
 * routes (see `@/auth/authClient`); these resolve the local user/team/role for
 * whoever the session cookie belongs to.
 */

/** What sign-in methods this deployment supports. */
export interface AuthCapabilities {
  /** Whether Google credentials are configured, and the button is worth showing. */
  google: boolean;
  /** Whether a new account must confirm its address before it can sign in. */
  email_verification_required: boolean;
}

/**
 * Read which sign-in methods this deployment actually supports.
 *
 * Unauthenticated on purpose — the login and signup pages call it before any
 * session exists.
 */
export function fetchAuthCapabilities(): Promise<AuthCapabilities> {
  return api<AuthCapabilities>('/auth/capabilities');
}

/** Fetch the current user, team, and role. Throws 401 if the session is absent/invalid. */
export function fetchMe(): Promise<Me> {
  return api<Me>('/auth/me');
}

/** List the teams the current user belongs to (with their role in each). */
export function fetchMyTeams(): Promise<{ teams: TeamMembership[] }> {
  return api<{ teams: TeamMembership[] }>('/auth/teams');
}

/** Switch the active team; returns the new me-shaped payload. */
export function switchTeam(teamId: string): Promise<Me> {
  return api<Me>('/auth/switch-team', { method: 'POST', body: { teamId } });
}
