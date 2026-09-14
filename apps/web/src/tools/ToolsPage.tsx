import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTools } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Empty, Input, PageSpinner, Tabs } from '@/ui';
import type { TabItem } from '@/ui';
import { filterTools, toolStatus, toolVersionSummary } from './catalog';
import { ToolAnalyticsPanel } from './ToolAnalyticsPanel';
import { ToolDialog } from './ToolDialog';

const TABS: TabItem[] = [
  { value: 'catalog', label: 'Catalog' },
  { value: 'analytics', label: 'Analytics' },
];

/**
 * The tool catalog: every tool the team owns, what state each one is in, and where it
 * runs — plus the usage numbers, as a tab rather than a second sidebar entry.
 *
 * Each row answers the question a list of names could not: whether the model can
 * actually call this tool. A tool is created and defined in one dialog now, so a shell
 * with no version is a rare state — but it can still arrive over the API, and a row that
 * says nothing about it is how a prompt ends up silently running with one tool fewer.
 */
export function ToolsPage() {
  const { canWrite } = useAuth();
  const { data, isLoading, isError } = useTools();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'analytics' ? 'analytics' : 'catalog';
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');

  const tools = useMemo(() => data ?? [], [data]);
  const shown = useMemo(() => filterTools(tools, query), [tools, query]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Tools</h1>
          <p className="mt-1 text-[13px] text-muted">
            Functions the model can call. Each one is versioned like a prompt, and says whether your
            code runs it or AcruxCore does.
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" className="ml-auto flex-none whitespace-nowrap" onClick={() => setDialogOpen(true)}>
            New tool
          </Button>
        )}
      </header>

      <Tabs
        items={TABS}
        value={tab}
        onChange={(value) => setSearchParams(value === 'analytics' ? { tab: 'analytics' } : {})}
      />

      {tab === 'analytics' ? (
        <ToolAnalyticsPanel />
      ) : isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load tools" description="Please try again." />
      ) : tools.length === 0 ? (
        <Empty
          title="No tools yet"
          description="A tool is a function the model can ask you to run. Create one here, or let your code create it on its first run with @acrux.tool."
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                New tool
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            aria-label="Search tools"
          />

          {shown.length === 0 ? (
            <Empty title={`No tool matches “${query.trim()}”`} description="Try a different word." />
          ) : (
            <ul className="overflow-hidden rounded-xl border border-line">
              {shown.map((t) => {
                const status = toolStatus(t);
                const summary = toolVersionSummary(t);
                return (
                  <li key={t.id} className="border-b border-line-soft bg-surface last:border-b-0">
                    <Link
                      to={`/tools/${t.id}`}
                      className="flex items-start gap-4 px-4 py-3.5 transition-colors hover:bg-elevated"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[14px] font-medium text-ink">{t.name}</p>
                        {t.description && (
                          <p className="mt-0.5 truncate text-[12.5px] text-muted">{t.description}</p>
                        )}
                        <p className="mt-0.5 truncate text-[12px] text-faint">
                          {summary ? `${summary} · ` : ''}created {timeAgo(t.createdAt)}
                        </p>
                        {status.hint && (
                          <p className="mt-1 text-[12px] text-warn">{status.hint}</p>
                        )}
                      </div>
                      <Badge tone={status.tone === 'warn' ? 'warn' : 'muted'} className="mt-0.5 flex-none">
                        {status.label}
                      </Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <ToolDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
