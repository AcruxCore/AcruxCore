import { Link } from 'react-router-dom';
import { Button } from '@/ui';
import { STEP_TITLES, stepNumber } from './checklist';
import type { StepId } from './checklist';
import { useChecklist } from './useChecklist';

export interface SetupNextStepBannerProps {
  /** The checklist step this page completes. The banner shows once that step is done. */
  step: StepId;
}

/**
 * A "next step" banner for a dashboard page that also completes a setup step.
 *
 * A new user who reaches the Credentials or Models page from the sidebar, rather
 * than through the checklist's dialogs, otherwise has no pointer back to what comes
 * next. The banner appears once this page's step is done and the checklist is not,
 * and links back to it. It renders nothing for a team that has finished setup.
 *
 * @param step - The step the host page completes.
 * @returns The banner, or `null` when it has nothing to say.
 */
export function SetupNextStepBanner({ step }: SetupNextStepBannerProps) {
  const { loaded, active, doneCount, steps, isDone } = useChecklist();
  if (!loaded || active === null || !isDone(step)) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3"
      data-testid="setup-next-step"
    >
      <p className="min-w-0 flex-1 text-[13px] text-ink">
        Setup: {doneCount} of {steps.length} steps done. Next is step {stepNumber(active)}:{' '}
        <span className="font-medium">{STEP_TITLES[active]}</span>.
      </p>
      <Link to="/getting-started">
        <Button variant="primary" size="sm">Next step</Button>
      </Link>
    </div>
  );
}
