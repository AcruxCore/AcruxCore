import { useState } from 'react';
import type { AuditEntry } from '@/api';
import { useAudit } from '@/api';
import { dateTime, timeAgo } from '@/lib/format';
import { Button, Empty, PageSpinner } from '@/ui';

const EVENT_LABELS: Record<string, string> = {
  prompt_created: 'Prompt created',
  prompt_renamed: 'Prompt renamed',
  prompt_updated: 'Prompt updated',
  prompt_deleted: 'Prompt deleted',
  version_committed: 'Version committed',
  alias_promoted: 'Alias promoted',
  alias_deleted: 'Alias deleted',
  api_key_generated: 'API key generated',
  api_key_revoked: 'API key revoked',
  member_invited: 'Member invited',
  member_joined: 'Member joined',
  member_role_updated: 'Member role updated',
  member_removed: 'Member removed',
  member_invite_revoked: 'Invite revoked',
};

/** One-line human summary from an event's metadata, when useful. */
function detail(entry: AuditEntry): string | null {
  const m = entry.metadata;
  if (!m) return null;
  const parts: string[] = [];
  if (typeof m.versionNumber === 'number') parts.push(`v${m.versionNumber}`);
  if (typeof m.alias === 'string') parts.push(m.alias);
  if (typeof m.name === 'string') parts.push(m.name);
  return parts.length ? parts.join(' · ') : null;
}

/** Audit tab: paginated, human-readable trail of who changed what. */
export function AuditTab({ promptId }: { promptId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useAudit(promptId, page);

  if (isLoading) return <PageSpinner />;
  const entries = data?.data ?? [];
  if (entries.length === 0) {
    return <Empty title="No activity yet" description="Changes to this prompt will appear here." />;
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <ol className="overflow-hidden rounded-xl border border-line">
        {entries.map((e) => {
          const d = detail(e);
          return (
            <li
              key={e.id}
              className="flex items-center gap-3 border-b border-line-soft bg-surface px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="text-[13px] text-ink">
                  {EVENT_LABELS[e.event] ?? e.event}
                  {d && <span className="ml-2 font-mono text-[12px] text-accent">{d}</span>}
                </p>
                <p className="text-[12px] text-faint">{e.actor.email}</p>
              </div>
              <span className="ml-auto flex-none text-[12px] text-faint" title={dateTime(e.createdAt)}>
                {timeAgo(e.createdAt)}
              </span>
            </li>
          );
        })}
      </ol>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-[13px]">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-muted">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
