import { useMemo } from 'react';
import { useTools, useVersionById, useVersions } from '@/api';
import { Badge, Empty, PageSpinner } from '@/ui';

/** Props for {@link ToolsTab}. */
export interface ToolsTabProps {
  promptId: string;
  /** Owner/admin/editor — gates the attach-checklist, matching the Editor tab's write gate. */
  canWrite: boolean;
  /** Tool ids selected to attach on the *next* commit (lifted to PromptDetailPage). */
  selected: string[];
  /** Toggles one tool id in/out of `selected`. */
  onToggle: (toolId: string) => void;
}

/**
 * Tool attachment panel for a prompt's detail page.
 *
 * Attachment is fixed at commit time (TC3, immutable per version) — this tab does not
 * mutate an existing version. Instead it lets the user pick which catalog tools should
 * be attached the *next* time they commit from the Editor tab, and shows the tools
 * already attached to the latest committed version as read-only chips for reference.
 */
export function ToolsTab({ promptId, canWrite, selected, onToggle }: ToolsTabProps) {
  const tools = useTools();
  const versions = useVersions(promptId);

  const latest = useMemo(() => {
    const items = versions.data?.data ?? [];
    if (items.length === 0) return null;
    return items.reduce((a, b) => (b.versionNumber > a.versionNumber ? b : a));
  }, [versions.data]);

  const latestVersion = useVersionById(latest?.id ?? null);

  if (tools.isLoading || versions.isLoading) return <PageSpinner />;

  const catalog = tools.data?.data ?? [];
  const attached = latestVersion.data?.tools ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-faint">
          {latest ? `Attached to v${latest.versionNumber}` : 'Attached tools'}
        </h3>
        {!latest ? (
          <p className="text-[13px] text-muted">
            No committed version yet — commit one in the Editor tab first.
          </p>
        ) : attached.length === 0 ? (
          <p className="text-[13px] text-muted">No tools attached to the latest version.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {attached.map((t) => (
              <Badge key={t.function.name} tone="default">
                <span className="font-mono">{t.function.name}</span>
              </Badge>
            ))}
          </div>
        )}
        <p className="text-[12px] text-faint">
          Attachments are fixed per version — commit a new version to change them.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-faint">
          Attach to next commit
        </h3>
        {!canWrite && (
          <p className="rounded-md border border-line bg-elevated px-3 py-2 text-[12.5px] text-muted">
            Your role is read-only. You can view attached tools, but not choose what attaches to
            the next commit.
          </p>
        )}
        {catalog.length === 0 ? (
          <Empty
            title="No tools in the catalog"
            description="Create a tool in the Tool Catalog to attach it to this prompt."
          />
        ) : (
          <div className="flex flex-col gap-1.5 rounded-md border border-line-soft bg-bg p-2.5">
            {catalog.map((t) => {
              const checked = selected.includes(t.id);
              return (
                <label
                  key={t.id}
                  className="flex items-center gap-2 text-[13px] text-ink"
                  title={!canWrite ? 'Read-only role — cannot change tool attachments.' : undefined}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    checked={checked}
                    disabled={!canWrite}
                    onChange={() => onToggle(t.id)}
                  />
                  <span className="font-mono">{t.name}</span>
                  {t.description && <span className="truncate text-faint">{t.description}</span>}
                </label>
              );
            })}
          </div>
        )}
        {selected.length > 0 && (
          <p className="text-[12px] text-faint">
            {selected.length} tool{selected.length === 1 ? '' : 's'} will attach to the next
            committed version.
          </p>
        )}
      </section>
    </div>
  );
}
