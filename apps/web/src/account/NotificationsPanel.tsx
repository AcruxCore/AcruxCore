import { useNotificationPreferences, useUpdateNotificationPreference } from '@/api';
import type { NotificationCategory } from '@/api';
import { useToast } from '@/ui';

/** One row per coarse category, in the order they matter to an operator. */
const CATEGORIES: {
  key: NotificationCategory;
  label: string;
  description: string;
}[] = [
  {
    key: 'budget_alerts',
    label: 'Budget alerts',
    description:
      'When a spend cap reaches 80%, and again when it is exhausted. Owners and admins only.',
  },
  {
    key: 'eval_runs',
    label: 'Evaluation run results',
    description: 'When a run you started finishes or fails. Counts only — no outputs.',
  },
  {
    key: 'membership',
    label: 'Membership changes',
    description: 'When someone joins, is removed, or has their role changed.',
  },
  {
    key: 'weekly_digest',
    label: 'Weekly usage digest',
    description: 'A Monday summary of spend, requests, traces, and runs. Owners and admins only.',
  },
];

/**
 * Email notification toggles for the signed-in user in their active team.
 *
 * Preferences are per team on purpose — someone who owns two teams may care about
 * one team's spend and not the other's — so the panel says which team it is
 * editing rather than implying an account-wide setting.
 */
export function NotificationsPanel({ teamName }: { teamName?: string }) {
  const toast = useToast();
  const { data, isLoading, isError } = useNotificationPreferences();
  const update = useUpdateNotificationPreference();

  const toggle = (category: NotificationCategory, enabled: boolean): void => {
    update.mutate(
      { category, enabled },
      { onError: () => toast.error('Could not update notification settings') },
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2 className="text-[15px] font-semibold">Email notifications</h2>
        <p className="mt-1 text-[13px] text-muted">
          Applies to {teamName ? <span className="text-ink">{teamName}</span> : 'your active team'}{' '}
          only. Switch teams to change another team&rsquo;s settings.
        </p>
      </header>

      {isError ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-[13px] text-muted">
          Couldn&rsquo;t load notification settings. Reload to try again.
        </p>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {CATEGORIES.map(({ key, label, description }) => {
            // While loading, render the rows in their default (on) state rather than
            // a spinner: the defaults are what the server will almost always
            // return, so the panel does not visibly reshuffle on arrival.
            const enabled = data ? data.preferences[key] : true;
            return (
              <div key={key} className="flex items-start gap-4 p-4">
                <div className="flex-1">
                  <div className="text-[14px] font-medium">{label}</div>
                  <p className="mt-1 text-[13px] text-muted">{description}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={label}
                  disabled={isLoading}
                  onClick={() => toggle(key, !enabled)}
                  data-testid={`notify-toggle-${key}`}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
                    enabled ? 'bg-accent' : 'bg-line'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface transition-all ${
                      enabled ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[12px] text-faint">
        Being removed from a team is always emailed, whatever these settings say — losing access is a
        security-relevant change.
      </p>
    </section>
  );
}
