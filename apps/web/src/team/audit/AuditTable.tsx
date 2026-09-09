import { Link } from 'react-router-dom';
import type { AuditEntry } from '@/api';
import { dateTime, timeAgo } from '@/lib/format';
import { Badge } from '@/ui';
import { eventGroupLabel, eventLabel } from './audit-events';
import { auditSummary } from './summary';

export interface AuditTableProps {
  entries: AuditEntry[];
}

/**
 * The team audit trail as a plain table — the app has no Table primitive, so this
 * mirrors {@link TraceTable}'s markup and spacing.
 *
 * Columns are Time, Area, Event, Detail, Actor. Time is first because the trail
 * is read newest-first and "when" is what anchors every audit question; the
 * absolute timestamp rides along as a `title` so hovering answers "which
 * Tuesday" without leaving the page.
 *
 * @param entries - Audit rows for the current page, newest first.
 */
export function AuditTable({ entries }: AuditTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
            <th className="px-4 py-2.5 font-medium">Time</th>
            <th className="px-4 py-2.5 font-medium">Area</th>
            <th className="px-4 py-2.5 font-medium">Event</th>
            <th className="px-4 py-2.5 font-medium">Detail</th>
            <th className="px-4 py-2.5 font-medium">Actor</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const detail = auditSummary(e);
            return (
              <tr key={e.id} className="border-b border-line-soft bg-surface last:border-b-0 hover:bg-elevated">
                <td className="whitespace-nowrap px-4 py-2.5 text-faint" title={dateTime(e.createdAt)}>
                  {timeAgo(e.createdAt)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Badge tone="muted">{eventGroupLabel(e.event)}</Badge>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-ink">{eventLabel(e.event)}</td>
                <td className="px-4 py-2.5">
                  {detail ? (
                    <span className="font-mono text-[12px] text-accent">{detail}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                  {/* A prompt-scoped event links straight to the prompt, so the
                      trail is a way into the object, not just a record of it. */}
                  {e.promptId && (
                    <Link
                      to={`/prompts/${e.promptId}`}
                      className="ml-2 text-[12px] text-muted underline decoration-dotted hover:text-accent"
                    >
                      view prompt
                    </Link>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{e.actor.email}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
