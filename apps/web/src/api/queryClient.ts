import { QueryClient } from '@tanstack/react-query';
import { ApiError, type ApiQuery } from './client';

/**
 * Shared TanStack Query client.
 *
 * Auth/permission failures (401/403) and not-found (404) are not retried —
 * retrying them is pointless and slows the UI. Other failures retry once.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) => {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          return false;
        }
        return count < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

/** Centralized query-key factory so hooks and invalidations stay in sync. */
export const keys = {
  me: ['me'] as const,
  myTeams: ['my-teams'] as const,
  prompts: (search?: string, page?: number) =>
    ['prompts', { search: search ?? '', page: page ?? 1 }] as const,
  prompt: (id: string) => ['prompt', id] as const,
  versions: (id: string) => ['versions', id] as const,
  version: (id: string, n: number) => ['version', id, n] as const,
  aliases: (id: string) => ['aliases', id] as const,
  diff: (id: string, from: number, to: number) => ['diff', id, from, to] as const,
  audit: (id: string, page: number) => ['audit', id, page] as const,
  apiKeys: ['api-keys'] as const,
  teamKeys: (teamId: string) => ['team-keys', teamId] as const,
  members: (teamId: string) => ['members', teamId] as const,
  invites: (teamId: string) => ['invites', teamId] as const,
  // Gateway (Phase 2)
  connections: ['gateway-connections'] as const,
  models: ['gateway-models'] as const,
  toolAnalytics: ['tools', 'analytics'] as const,
  virtualKeys: ['gateway-keys'] as const,
  budgets: ['gateway-budgets'] as const,
  usage: (from: string, to: string, groupBy: string, vk?: string) =>
    ['gateway-usage', { from, to, groupBy, vk: vk ?? '' }] as const,
  gatewayRequests: (params: Record<string, string | number | undefined>) =>
    ['gateway-requests', params] as const,
  gatewayRequest: (id: string) => ['gateway-request', id] as const,
  // Observability / Tracing (T7)
  traces: (filters: ApiQuery) => ['traces', filters] as const,
  trace: (id: string) => ['trace', id] as const,
  traceAnalytics: (params: Record<string, string | undefined>) => ['traceAnalytics', params] as const,
  sessions: (params: Record<string, string | number | undefined>) => ['sessions', params] as const,
  session: (id: string) => ['session', id] as const,
  promptVersionTraces: (promptId: string, n: number, page: number) =>
    ['promptVersionTraces', promptId, n, page] as const,
  traceSettings: ['traceSettings'] as const,
  notificationPreferences: ['notificationPreferences'] as const,
  traceFacets: ['traceFacets'] as const,
  traceFacetValues: (key: string) => ['traceFacetValues', key] as const,
  feedbackSummary: (params: Record<string, string | undefined>) => ['feedbackSummary', params] as const,
  feedbackFeed: (page: number, limit: number) => ['feedbackFeed', page, limit] as const,
  // Evaluations: datasets (E2)
  datasets: ['datasets'] as const,
  dataset: (id: string) => ['dataset', id] as const,
  // Evaluations: experiments (E3)
  experiments: ['experiments'] as const,
  experiment: (id: string) => ['experiment', id] as const,
  // Evaluations: runs + report + cell drill-down (E3/E5/E6)
  runs: (filters: ApiQuery) => ['runs', filters] as const,
  run: (id: string) => ['run', id] as const,
  runReport: (id: string) => ['runReport', id] as const,
  runCell: (id: string, cellKey: string) => ['runCell', id, cellKey] as const,
  // Evaluations: optimize + promote-review (E7)
  runCandidate: (id: string, candidateId: string) => ['runCandidate', id, candidateId] as const,
  // Tool Catalog (TC1-TC5)
  tools: ['tools'] as const,
  tool: (id: string) => ['tools', id] as const,
  toolVersions: (id: string) => ['tools', id, 'versions'] as const,
  toolVersion: (id: string, versionNumber: number) => ['tools', id, 'versions', versionNumber] as const,
  toolAliases: (id: string) => ['tools', id, 'aliases'] as const,
  // Secrets (TC4)
  secrets: ['secrets'] as const,
};
