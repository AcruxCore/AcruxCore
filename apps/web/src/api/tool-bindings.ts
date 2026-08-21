import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queryClient';

/**
 * One tool binding. `toolAlias` and `pinnedVersionNumber` are mutually exclusive,
 * and `off` is true when both are null — meaning this alias deliberately has no
 * such tool, contradicting a default that does hold it.
 */
export interface ToolBinding {
  toolId: string;
  toolName: string;
  toolAlias: string | null;
  pinnedVersionNumber: number | null;
  off: boolean;
  /** Tool version this resolves to right now, so a cell can show what will run. */
  resolvedVersionNumber: number | null;
  position: number;
}

/** One prompt alias and only the bindings it owns — never the inherited default. */
export interface AliasBindings {
  alias: string;
  versionNumber: number;
  /** False when this alias has no rows of its own and simply inherits the default. */
  customised: boolean;
  bindings: ToolBinding[];
}

/** The whole binding picture for one prompt. */
export interface PromptBindings {
  default: ToolBinding[];
  aliases: AliasBindings[];
}

/** The three states a grid cell can hold, as the API accepts them. */
export type BindingValue =
  | { tool_alias: string }
  | { pinned_version_number: number }
  | { off: true };

/** Every binding on a prompt: the default plus each alias, customised or not. */
export function usePromptToolBindings(promptId: string) {
  return useQuery({
    queryKey: keys.toolBindings(promptId),
    queryFn: () => api<{ data: PromptBindings }>(`/prompts/${promptId}/tools`),
    enabled: !!promptId,
  });
}

/**
 * Sets one binding. Pass `alias: null` to write the default that every
 * uncustomised alias inherits, or an alias name to give that alias its own value.
 */
export function useSetToolBinding(promptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      alias,
      toolId,
      value,
    }: {
      alias: string | null;
      toolId: string;
      value: BindingValue;
    }) =>
      api<ToolBinding>(
        alias === null
          ? `/prompts/${promptId}/tools/${toolId}`
          : `/prompts/${promptId}/aliases/${alias}/tools/${toolId}`,
        { method: 'PUT', body: value },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.toolBindings(promptId) }),
  });
}

/**
 * Removes one binding. On an alias that returns the pair to the inherited
 * default; on the default (`alias: null`) it unbinds the tool from the prompt for
 * every alias that was inheriting it.
 */
export function useRemoveToolBinding(promptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ alias, toolId }: { alias: string | null; toolId: string }) =>
      api<void>(
        alias === null
          ? `/prompts/${promptId}/tools/${toolId}`
          : `/prompts/${promptId}/aliases/${alias}/tools/${toolId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.toolBindings(promptId) }),
  });
}

/** Drops every row one alias owns, returning it wholesale to the default. */
export function useResetAliasBindings(promptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ alias }: { alias: string }) =>
      api<void>(`/prompts/${promptId}/aliases/${alias}/tools`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.toolBindings(promptId) }),
  });
}
