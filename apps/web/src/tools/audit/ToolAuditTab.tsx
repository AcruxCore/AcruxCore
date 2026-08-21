import { useState } from 'react';
import type { AuditEntry } from '@/api';
import { useToolAudit } from '@/api';
import { dateTime, timeAgo } from '@/lib/format';
import { Badge, Button, Empty, PageSpinner } from '@/ui';

const EVENT_LABELS: Record<string, string> = {
  tool_created: 'Tool created',
  tool_version_committed: 'Version committed',
  tool_alias_promoted: 'Alias promoted',
  tool_version_superseded: 'Version superseded by code sync',
  // Event names kept from the superseded design so existing history stays
  // queryable; the labels say what the action is now.
  prompt_tool_route_set: 'Prompt binding set',
  prompt_tool_route_removed: 'Prompt binding removed',
};

/** One-line human summary from a tool event's metadata. */
function detail(entry: AuditEntry): string | null {
  const m = entry.metadata;
  if (!m) return null;
  const parts: string[] = [];

  if (entry.event === 'tool_alias_promoted') {
    if (typeof m.alias === 'string') parts.push(m.alias);
    if (typeof m.fromVersionNumber === 'number' && typeof m.toVersionNumber === 'number') {
      parts.push(`v${m.fromVersionNumber} → v${m.toVersionNumber}`);
    } else if (typeof m.toVersionNumber === 'number') {
      parts.push(`→ v${m.toVersionNumber}`);
    }
    return parts.length ? parts.join(' · ') : null;
  }

  if (entry.event === 'tool_version_superseded') {
    if (typeof m.supersededVersionNumber === 'number' && typeof m.newVersionNumber === 'number') {
      parts.push(`v${m.supersededVersionNumber} → v${m.newVersionNumber}`);
    }
    if (typeof m.supersededSource === 'string') parts.push(`was ${m.supersededSource}-authored`);
    return parts.length ? parts.join(' · ') : null;
  }

  if (entry.event === 'prompt_tool_route_set') {
    // promptAlias is null for the default binding every alias inherits.
    parts.push(typeof m.promptAlias === 'string' ? `alias "${m.promptAlias}"` : 'default');
    if (typeof m.toolName === 'string') parts.push(m.toolName);
    if (m.off === true) {
      parts.push('excluded here');
    } else if (m.pinned === true) {
      parts.push('pinned');
    } else if (typeof m.fromToolAlias === 'string' && typeof m.toToolAlias === 'string') {
      parts.push(`${m.fromToolAlias} → ${m.toToolAlias}`);
    } else if (typeof m.toToolAlias === 'string') {
      parts.push(`→ ${m.toToolAlias}`);
    }
    return parts.length ? parts.join(' · ') : null;
  }

  if (entry.event === 'prompt_tool_route_removed') {
    if (m.reset === true) {
      const n = typeof m.removedCount === 'number' ? m.removedCount : null;
      parts.push(`alias "${String(m.promptAlias)}" reset to default`);
      if (n !== null) parts.push(`${n} binding${n === 1 ? '' : 's'} dropped`);
      return parts.join(' · ');
    }
    parts.push(typeof m.promptAlias === 'string' ? `alias "${m.promptAlias}"` : 'default');
    if (typeof m.fromToolAlias === 'string') parts.push(`was ${m.fromToolAlias}`);
    return parts.length ? parts.join(' · ') : null;
  }

  if (typeof m.versionNumber === 'number') parts.push(`v${m.versionNumber}`);
  if (typeof m.via === 'string') parts.push(m.via);
  return parts.length ? parts.join(' · ') : null;
}

/** `true` for a `tool_version_committed` event whose `via` metadata is `'sync'` —
 * i.e. it came from a code push (`POST /tools/sync`), not a dashboard/API commit. */
function isFromSync(entry: AuditEntry): boolean {
  return entry.event === 'tool_version_committed' && entry.metadata?.via === 'sync';
}

/** Tool audit tab: paginated trail of version commits, alias promotions, and
 * code-sync supersedes — so an admin can see when a code push moved production
 * out from under a prompt without opening the Aliases tab to notice. */
export function ToolAuditTab({ toolId }: { toolId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useToolAudit(toolId, page);

  if (isLoading) return <PageSpinner />;
  const entries = data?.data ?? [];
  if (entries.length === 0) {
    return <Empty title="No activity yet" description="Version commits and alias changes for this tool will appear here." />;
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
                  {isFromSync(e) && (
                    <Badge tone="muted" className="ml-2 align-middle">
                      code sync
                    </Badge>
                  )}
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
