import { Link } from 'react-router-dom';
import { useTeamAudit } from '@/api';
import { dateTime, timeAgo } from '@/lib/format';
import { Badge, PageSpinner } from '@/ui';
import { eventGroupLabel, eventLabel } from './audit-events';
import { auditSummary } from './summary';

/** How many of the newest events the Team page previews. */
const PREVIEW_COUNT = 5;

/**
 * Team-page panel showing the newest few audit events, with a link through to
 * the full trail.
 *
 * It exists so the audit trail is discoverable from the screen an owner already
 * visits to manage members and keys, instead of only from the nav rail. It
 * deliberately shows no filters: a preview that needs configuring is not a
 * preview.
 *
 * @param teamId - The team whose trail to preview; owner/admin only.
 */
export function RecentActivityPanel({ teamId }: { teamId: string }) {
  const { data, isLoading, isError } = useTeamAudit(teamId, 1);
  const entries = (data?.data ?? []).slice(0, PREVIEW_COUNT);

  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft p-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Recent activity</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {data ? `${data.total.toLocaleString()} recorded actions in this team.` : 'Who changed what, and when.'}
          </p>
        </div>
        <Link
          to="/team/audit"
          className="ml-auto rounded-md border border-line px-2.5 py-1.5 text-[12.5px] text-ink hover:border-accent hover:text-accent"
        >
          View audit trail
        </Link>
      </div>

      {isLoading ? (
        <div className="p-8">
          <PageSpinner />
        </div>
      ) : isError ? (
        <p className="p-4 text-[13px] text-muted">Couldn’t load recent activity.</p>
      ) : entries.length === 0 ? (
        <p className="p-4 text-[13px] text-muted">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {entries.map((e) => {
            const detail = auditSummary(e);
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <Badge tone="muted">{eventGroupLabel(e.event)}</Badge>
                <span className="text-[13px] text-ink">{eventLabel(e.event)}</span>
                {detail && <span className="font-mono text-[12px] text-accent">{detail}</span>}
                <span className="ml-auto flex items-center gap-3 text-[12px] text-faint">
                  <span className="truncate">{e.actor.email}</span>
                  <span title={dateTime(e.createdAt)}>{timeAgo(e.createdAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
