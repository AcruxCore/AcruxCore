import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GrantableRole, InviteListItem, MemberListItem } from './types';
import { api } from './client';
import { keys } from './queryClient';

// ── Members ───────────────────────────────────────────────────────────────

/** List a team's members and the one role each of them holds. */
export function useMembers(teamId: string) {
  return useQuery({
    queryKey: keys.members(teamId),
    queryFn: () => api<MemberListItem[]>(`/teams/${teamId}/members`),
    enabled: !!teamId,
  });
}

/** Replace a member's role (owner/admin only; owner role is not grantable). */
export function useUpdateRole(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; role: GrantableRole }) =>
      api<MemberListItem>(`/teams/${teamId}/members/${input.userId}/roles`, {
        method: 'PATCH',
        body: { role: input.role },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(teamId) }),
  });
}

/** Remove a member from the team. */
export function useRemoveMember(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.members(teamId) }),
  });
}

// ── Invites ───────────────────────────────────────────────────────────────

/** List a team's pending invites. */
export function useInvites(teamId: string) {
  return useQuery({
    queryKey: keys.invites(teamId),
    queryFn: () => api<InviteListItem[]>(`/teams/${teamId}/invites`),
    enabled: !!teamId,
  });
}

/** Create a single-use invite for the given role; returns the shareable token. */
export function useCreateInvite(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { role: GrantableRole; email?: string }) =>
      api<InviteListItem>(`/teams/${teamId}/invites`, {
        method: 'POST',
        body: input.email ? { role: input.role, email: input.email } : { role: input.role },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites(teamId) }),
  });
}

/** Revoke a pending invite. */
export function useRevokeInvite(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api<void>(`/teams/${teamId}/invites/${inviteId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites(teamId) }),
  });
}

/** Accept an invite by token — adds the current user to the invite's team. */
export function acceptInvite(token: string): Promise<unknown> {
  return api<unknown>(`/teams/invites/${token}/accept`, { method: 'POST', body: {} });
}
