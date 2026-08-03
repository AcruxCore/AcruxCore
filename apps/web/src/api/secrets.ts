import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queryClient';
import type { CreateSecretInput, Secret } from './types';

/** List the team's secrets (masked — name + last four only). Any role. */
export function useSecrets() {
  return useQuery({
    queryKey: keys.secrets,
    queryFn: () => api<Secret[]>('/secrets'),
  });
}

/** Create a secret, referenced as `{{secret.NAME}}` in HTTP tool executors (owner/admin/editor). */
export function useCreateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSecretInput) => api<Secret>('/secrets', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.secrets }),
  });
}

/** Rotate a secret's value in place, keeping its name and existing references intact. */
export function useRotateSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      api<Secret>(`/secrets/${id}`, { method: 'PUT', body: { value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.secrets }),
  });
}

/** Permanently delete a secret. */
export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/secrets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.secrets }),
  });
}
