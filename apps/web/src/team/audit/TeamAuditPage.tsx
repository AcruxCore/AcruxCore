import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { TEAM_AUDIT_PAGE_SIZE, useTeamAudit, useTeamAuditActors } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { Button, Empty, PageSpinner } from '@/ui';
import { AuditFilterBar, type AuditFilterValue } from './AuditFilterBar';
import { AuditTable } from './AuditTable';
import { toEventNames } from './audit-events';

/**
 * Reads the filter state out of the query string. The URL is the source of
 * truth, matching the trace list, so a filtered trail can be linked to a
 * colleague or a ticket — which is most of the point of an audit screen.
 */
function parseFilters(sp: URLSearchParams): AuditFilterValue {
  const list = (key: string) => (sp.get(key) ?? '').split(',').filter(Boolean);
  return { groups: list('group'), events: list('event'), actorId: sp.get('actor') ?? '' };
}

/**
 * The team-wide audit trail at `/team/audit`: every recorded action in the team,
 * newest first, filterable by area, event and actor.
 *
 * Owner/admin only — the endpoint enforces that with a 403, and this page shows
 * it as a message rather than an error, because an editor reaching it by a
 * shared link has not done anything wrong.
 */
export function TeamAuditPage() {
  const { me, canManageTeam } = useAuth();
  const teamId = me?.team.id ?? '';

  const [sp, setSp] = useSearchParams();
  const filters = parseFilters(sp);
  const page = Number(sp.get('page')) || 1;

  const events = toEventNames(filters.groups, filters.events);
  const trail = useTeamAudit(canManageTeam ? teamId : '', page, {
    events,
    actorId: filters.actorId || undefined,
  });
  const actors = useTeamAuditActors(canManageTeam ? teamId : '');

  const setFilters = useCallback(
    (next: AuditFilterValue) => {
      const params = new URLSearchParams(sp);
      const set = (key: string, value: string) => (value ? params.set(key, value) : params.delete(key));
      set('group', next.groups.join(','));
      set('event', next.events.join(','));
      set('actor', next.actorId);
      // Any filter change invalidates the page number: staying on page 7 of a
      // result set that now has two pages shows an empty table and reads as a bug.
      params.delete('page');
      setSp(params);
    },
    [sp, setSp],
  );

  const goTo = (p: number) => {
    const params = new URLSearchParams(sp);
    params.set('page', String(p));
    setSp(params);
  };

  if (!canManageTeam) {
    return (
      <div className="flex flex-col gap-6">
        <Header />
        <Empty
          title="Only owners and admins can read the audit trail"
          description="Ask an owner of this team for access, or open the Team page for what you can see."
        />
      </div>
    );
  }

  const total = trail.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / TEAM_AUDIT_PAGE_SIZE));
  const isFiltered = events.length > 0 || filters.actorId !== '';

  return (
    <div className="flex flex-col gap-5">
      <Header />

      <AuditFilterBar
        value={filters}
        onChange={setFilters}
        actors={actors.data?.data ?? []}
        actorsLoading={actors.isLoading}
        total={total}
      />

      {trail.isLoading ? (
        <PageSpinner />
      ) : trail.isError ? (
        <Empty title="Couldn’t load the audit trail" description="Something went wrong fetching events. Try again." />
      ) : (trail.data?.data.length ?? 0) === 0 ? (
        <Empty
          title={isFiltered ? 'No events match these filters' : 'No activity recorded yet'}
          description={
            isFiltered
              ? 'Clear a filter, or widen the area to every event.'
              : 'Every change to prompts, tools, keys, members and gateway settings will appear here.'
          }
        />
      ) : (
        <>
          <AuditTable entries={trail.data!.data} />
          {totalPages > 1 && (
            <div className="flex items-center gap-3 text-[13px] text-muted">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => goTo(page - 1)}>
                Previous
              </Button>
              <span>
                Page {page} of {totalPages.toLocaleString()}
              </span>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => goTo(page + 1)}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Page title and the link back to the Team screen this page hangs off. */
function Header() {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Audit trail</h1>
        <p className="mt-1 text-[13px] text-muted">
          Every recorded action in this team — who did what, and when. Newest first.
        </p>
      </div>
      <Link to="/team" className="text-[13px] text-muted underline decoration-dotted hover:text-accent">
        Back to Team
      </Link>
    </header>
  );
}
