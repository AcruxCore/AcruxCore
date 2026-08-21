import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommitVersionInput,
  Paginated,
  VersionByIdResponse,
  VersionDetail,
  VersionListItem,
} from './types';
import { api } from './client';
import { keys } from './queryClient';

/** List a prompt's versions (newest first, paginated by the API). */
export function useVersions(promptId: string) {
  return useQuery({
    queryKey: keys.versions(promptId),
    queryFn: () =>
      api<Paginated<VersionListItem>>(`/prompts/${promptId}/versions`, {
        query: { limit: 100 },
      }),
    enabled: !!promptId,
  });
}

/** Fetch one version's full content (messages + variables). */
export function useVersion(promptId: string, versionNumber: number | null) {
  return useQuery({
    queryKey: keys.version(promptId, versionNumber ?? 0),
    queryFn: () =>
      api<VersionDetail>(`/prompts/${promptId}/versions/${versionNumber}`),
    enabled: !!promptId && !!versionNumber,
  });
}

/**
 * Resolves a prompt-version UUID to its prompt + raw messages, for Playground
 * prefill from a trace/feedback span. Disabled until an id is provided.
 */
export function useVersionById(versionId: string | null) {
  return useQuery({
    queryKey: ['prompt-version-by-id', versionId],
    enabled: !!versionId,
    queryFn: () => api<VersionByIdResponse>(`/prompt-versions/${versionId}`),
  });
}

/**
 * Commit a new immutable version from a messages array.
 *
 * A version decides the template only — which tools the prompt calls lives in
 * its tool bindings, keyed by prompt alias rather than by version, so committing
 * says nothing about tools.
 *
 * Takes `promptId` per-call (as a mutation variable) rather than as a hook
 * argument, since some callers (e.g. "save as new prompt") only learn the
 * target prompt's id from a prior mutation's result — a hook-time id would
 * be stale on the very call that needs the freshly created one.
 */
export function useCommitVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ promptId, messages, model }: CommitVersionInput) =>
      api<VersionDetail>(`/prompts/${promptId}/versions`, {
        method: 'POST',
        body: { messages, ...(model ? { model } : {}) },
      }),
    onSuccess: (_data, { promptId }) => {
      qc.invalidateQueries({ queryKey: keys.versions(promptId) });
      qc.invalidateQueries({ queryKey: keys.aliases(promptId) });
      qc.invalidateQueries({ queryKey: ['audit', promptId] });
    },
  });
}
