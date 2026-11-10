import { useQuery } from '@tanstack/react-query';
import { api, keys, useConnections, useModels } from '@/api';
import type { OnboardingStatus } from '@/api/types';
import { checklistSteps, currentStep } from './checklist';
import type { ChecklistStep, StepId } from './checklist';

/** How often the checklist page re-checks while a step is still open. */
const POLL_MS = 5_000;

/** The team's onboarding progress, read from the real API. */
export interface Checklist {
  /** False until the status has loaded. */
  loaded: boolean;
  /** True when the status request failed. The page shows a retry instead of a spinner. */
  failed: boolean;
  /** Re-requests the status after a failure. */
  retry: () => void;
  steps: ChecklistStep[];
  /** The first unfinished step, or `null` when all are done. */
  active: StepId | null;
  doneCount: number;
  isDone: (id: StepId) => boolean;
  /** Only used for the step summaries ("2 credentials saved"); the page does not wait for them. */
  connections: ReturnType<typeof useConnections>;
  models: ReturnType<typeof useModels>;
}

/**
 * Reads the team's getting-started status and turns it into checklist steps.
 *
 * One request, `GET /onboarding`, answers all four steps for the whole team, so an
 * editor or viewer whose owner finished setup sees every step done. Any successful
 * mutation in the dashboard re-reads it (see the mutation cache in `queryClient`), so
 * saving a credential or a key anywhere refreshes the checklist and the banner.
 *
 * @param options.poll - Re-check every 5 s until every step is done. Only the checklist
 *   page sets it, so a request sent from a terminal ticks step 4 without a reload.
 * @returns The current {@link Checklist}.
 */
export function useChecklist(options: { poll?: boolean } = {}): Checklist {
  const status = useQuery({
    queryKey: keys.onboarding,
    queryFn: () => api<OnboardingStatus>('/onboarding'),
    refetchInterval: (query) => {
      const s = query.state.data;
      const allDone = s !== undefined && s.credential && s.model && s.apiKey && s.firstRequest;
      // Keeps polling after an error too, so a page showing the error recovers on its own.
      return options.poll && !allDone ? POLL_MS : false;
    },
  });
  const connections = useConnections();
  const models = useModels();

  const steps = checklistSteps(
    status.data ?? { credential: false, model: false, apiKey: false, firstRequest: false },
  );

  return {
    // A failed poll keeps the last good answer, so only a failure with no data at all
    // counts as "failed"; otherwise the page would flip to an error on one bad poll.
    loaded: status.data !== undefined,
    failed: status.isError && status.data === undefined,
    retry: () => void status.refetch(),
    steps,
    active: currentStep(steps),
    doneCount: steps.filter((s) => s.done).length,
    isDone: (id) => steps.find((s) => s.id === id)?.done ?? false,
    connections,
    models,
  };
}
