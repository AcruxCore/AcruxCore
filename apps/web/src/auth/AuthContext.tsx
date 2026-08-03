import { useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMe, keys, setUnauthorizedHandler, switchTeam as apiSwitchTeam } from '@/api';
import type { Me, Role } from '@/api';
import { authClient } from './authClient';
import { AuthContext, type AuthValue } from './auth-context-core';

export { useOptionalAuth } from './auth-context-core';
export type { AuthValue } from './auth-context-core';

/**
 * Bootstraps auth state from `GET /auth/me`.
 *
 * Deliberately has no client-side session layer. Under Supabase this provider
 * tracked a `Session` object, subscribed to `onAuthStateChange`, and gated the
 * `/auth/me` query on a session existing — two sources of truth that could
 * disagree, and a token sitting in `localStorage`. With an httpOnly cookie the
 * browser attaches the credential itself, so the API's answer *is* the state:
 * `me` means signed in, a 401 means signed out. The global 401 handler covers a
 * session that is revoked or expires mid-visit.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const meQuery = useQuery({
    queryKey: keys.me,
    queryFn: fetchMe,
    retry: false,
    staleTime: Infinity,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(keys.me, null);
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const value = useMemo<AuthValue>(() => {
    const me = (meQuery.data as Me | null | undefined) ?? null;
    const role = me?.role ?? null;
    const is = (...r: Role[]) => !!role && r.includes(role);
    return {
      me,
      role,
      // A 401 resolves the query (it is not a retryable error here), so
      // `isPending` is the whole of "we do not know yet".
      isLoading: meQuery.isPending,
      isAuthenticated: !!me,
      canWrite: is('owner', 'admin', 'editor'),
      canManageTeam: is('owner', 'admin'),
      refresh: () => meQuery.refetch(),
      signOut: async () => {
        try {
          await authClient.signOut();
        } finally {
          // Clear locally even if the request failed: the user asked to leave,
          // and the next API call would 401 anyway.
          //
          // Same hazard `switchTeam` documents below, in reverse: `qc.clear()`
          // would drop the entry `setQueryData` just wrote and detach the
          // mounted `me` observer without notifying it, so the observer refetches
          // — an extra `GET /auth/me` and a spinner flash on the way out. Seed
          // the signed-out identity, then remove every *other* cached query so
          // no team data survives into the next session.
          qc.setQueryData(keys.me, null);
          qc.removeQueries({
            predicate: (query) => query.queryKey[0] !== keys.me[0],
          });
        }
      },
      switchTeam: async (teamId: string) => {
        const newMe = await apiSwitchTeam(teamId);
        // Seed the new identity via setQueryData (which notifies the mounted
        // `me` observer) instead of qc.clear() + seed: clear() detaches active
        // observers without notifying them, so the old team's `me` could keep
        // rendering indefinitely. Then drop every other cached query so no
        // old-team data leaks into the new team. `myTeams` survives (the
        // membership list is team-independent); TeamSwitcher keeps it fresh.
        qc.setQueryData(keys.me, newMe);
        qc.removeQueries({
          predicate: (query) =>
            query.queryKey[0] !== keys.me[0] && query.queryKey[0] !== keys.myTeams[0],
        });
      },
    };
  }, [meQuery.data, meQuery.isPending, qc, meQuery]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Access auth state and permissions.
 *
 * @returns The current auth value.
 * @throws {Error} If used outside an AuthProvider.
 */
export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
