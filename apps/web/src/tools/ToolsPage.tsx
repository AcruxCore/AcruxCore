import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTools } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Button, Empty, PageSpinner } from '@/ui';
import { ToolDialog } from './ToolDialog';

/**
 * Tool catalog list: every tool the team owns, linking to its detail page
 * for versions/aliases/executor management. Mirrors `ConnectionsPage`'s
 * header + list + create-dialog structure. Creating a tool is gated behind
 * `canWrite` (owner/admin/editor), matching the server's commit/promote gate.
 */
export function ToolsPage() {
  const { canWrite } = useAuth();
  const { data, isLoading, isError } = useTools();
  const [dialogOpen, setDialogOpen] = useState(false);

  const tools = data?.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Tools</h1>
          <p className="mt-1 text-[13px] text-muted">
            Callable tools the gateway can execute or hand to the model, versioned like prompts.
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" className="ml-auto" onClick={() => setDialogOpen(true)}>
            New tool
          </Button>
        )}
      </header>

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load tools" description="Please try again." />
      ) : tools.length === 0 ? (
        <Empty
          title="No tools yet"
          description="Create a tool, then commit a version to define its parameters and executor."
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                New tool
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {tools.map((t) => (
            <li key={t.id} className="border-b border-line-soft bg-surface last:border-b-0">
              <Link
                to={`/gateway/tools/${t.id}`}
                className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-elevated"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-[14px] font-medium text-ink">{t.name}</p>
                  <p className="mt-0.5 truncate text-[12.5px] text-faint">
                    {t.description ? `${t.description} · ` : ''}created {timeAgo(t.createdAt)}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <ToolDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
