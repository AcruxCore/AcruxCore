import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiKeyCreated, ApiKeyListItem } from './types';
import { api } from './client';
import { keys } from './queryClient';

// ── Personal API keys ───────────────────────────────────────────────────────

/** List the caller's personal API keys (secret value not included). */
export function usePersonalKeys() {
  return useQuery({
    queryKey: keys.apiKeys,
    queryFn: () => api<ApiKeyListItem[]>('/api-keys'),
  });
}

/** Create a personal API key; the full secret is returned exactly once. */
export function useCreatePersonalKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string }) =>
      api<ApiKeyCreated>('/api-keys', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys }),
  });
}

/** Revoke a personal API key. */
export function useRevokePersonalKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys }),
  });
}

// ── Team-scoped API keys ──────────────────────────────────────────────────────

/** List a team's API keys (owner/admin only). */
export function useTeamKeys(teamId: string) {
  return useQuery({
    queryKey: keys.teamKeys(teamId),
    queryFn: () => api<ApiKeyListItem[]>(`/teams/${teamId}/api-keys`),
    enabled: !!teamId,
  });
}

/** Create a team-scoped API key; the full secret is returned exactly once. */
export function useCreateTeamKey(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string }) =>
      api<ApiKeyCreated>(`/teams/${teamId}/api-keys`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.teamKeys(teamId) }),
  });
}

/** Revoke a team-scoped API key. */
export function useRevokeTeamKey(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api<void>(`/teams/${teamId}/api-keys/${keyId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.teamKeys(teamId) }),
  });
}
