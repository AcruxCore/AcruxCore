import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CommitVersionInput,
  Message,
  Paginated,
  VersionByIdResponse,
  VersionDetail,
  VersionListItem,
} from './types';
import { api, ApiError } from './client';
import { fetchAllPages } from './paging';
import { keys } from './queryClient';

/**
 * List every one of a prompt's versions, newest first.
 *
 * Reads all pages rather than the API's first-page default (which the server caps at
 * `limit=100`): this list feeds the promote/rollback control, so a prompt with more than
 * 100 committed versions must not have its oldest versions quietly become impossible to
 * roll back to.
 */
export function useVersions(promptId: string) {
  return useQuery({
    queryKey: keys.versions(promptId),
    queryFn: () =>
      fetchAllPages<VersionListItem>(
        (page, limit) =>
          api<Paginated<VersionListItem>>(`/prompts/${promptId}/versions`, { query: { page, limit } }),
        `GET /prompts/${promptId}/versions`,
      ),
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

/**
 * Renders an unsaved draft for the Preview tab on the server, in the API's template sandbox.
 *
 * The page must never render a template itself: nunjucks compiles one into JavaScript and
 * lets attribute access reach the Function constructor, so a teammate's stored template
 * would run its code in the viewer's session. The server runs the same nunjucks in an
 * isolated-vm sandbox and returns text.
 *
 * Callers debounce `messages` and `variables`, since every distinct pair is one request.
 * The previous result stays on screen while the next one loads, so typing does not
 * flicker. A template error comes back as an `ApiError` (422 `TEMPLATE_RENDER_ERROR`).
 *
 * @param promptId - The prompt the draft belongs to; scopes the call to the team.
 * @param messages - The draft messages, exactly as edited.
 * @param variables - Values from the Preview's fields, lists and objects already parsed.
 * @param enabled - False to skip the request, e.g. while the draft is blank.
 * @returns The react-query result holding `{ messages }`.
 */
export function usePreviewRender(
  promptId: string,
  messages: Message[],
  variables: Record<string, unknown>,
  enabled: boolean,
) {
  return useQuery({
    queryKey: keys.preview(promptId, messages, variables),
    queryFn: () =>
      api<{ messages: Message[] }>(`/prompts/${promptId}/preview`, {
        method: 'POST',
        body: { messages, variables },
      }),
    enabled: enabled && !!promptId,
    placeholderData: keepPreviousData,
    // A template error is final. A 429 means the team already has previews rendering
    // (the server allows two at once), so try again shortly instead of showing an error.
    retry: (failures, err) => err instanceof ApiError && err.status === 429 && failures < 3,
    retryDelay: 1000,
    // A draft and its values render the same every time, so a cached answer never goes stale.
    staleTime: Infinity,
  });
}
