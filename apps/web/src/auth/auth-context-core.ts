import { createContext, useContext } from 'react';
import type { Me, Role } from '@/api';

export interface AuthValue {
  me: Me | null;
  role: Role | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True for owner/admin/editor — may create prompts, commit, promote. */
  canWrite: boolean;
  /** True for owner/admin — may manage members, invites, team keys. */
  canManageTeam: boolean;
  /** Re-fetch `/auth/me` (after login/signup). */
  refresh: () => Promise<unknown>;
  /** End the session and clear cached data. */
  signOut: () => Promise<void>;
  /** Switch the active team, reset cached data, and refresh identity. */
  switchTeam: (teamId: string) => Promise<void>;
}

/**
 * The auth React context, kept in its own dependency-free module.
 *
 * {@link AuthContext.tsx} (the `AuthProvider`/`useAuth` module) transitively
 * imports `authClient`, which calls `createAuthClient({ baseURL:
 * window.location.origin })` at module load time — fine in the browser, fatal
 * under Node. The public marketing site's shared header needs to read auth
 * state too (see {@link useOptionalAuth}) but is also rendered by the static
 * prerender script, which runs in Node with no `window`. Importing only this
 * module keeps that path free of `authClient`.
 */
export const AuthContext = createContext<AuthValue | null>(null);

/**
 * Access auth state without requiring an `AuthProvider` ancestor.
 *
 * For components shared between the authenticated app and the public marketing
 * site (e.g. `MarketingHeader`), which is also rendered standalone by the
 * static prerender script with no provider in the tree.
 *
 * @returns The current auth value, or `null` outside an `AuthProvider`.
 */
export function useOptionalAuth(): AuthValue | null {
  return useContext(AuthContext);
}
