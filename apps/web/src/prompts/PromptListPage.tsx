import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePrompts } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Button, Empty, Input, PageSpinner } from '@/ui';
import { PromptCreateDialog } from './PromptCreateDialog';

/** Prompt list: search, pagination, empty state, and the create entry point. */
export function PromptListPage() {
  const { canWrite } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const { data, isLoading, isError } = usePrompts({ search: search || undefined, page });
  const prompts = data?.data ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Prompts</h1>
          <p className="mt-1 text-[13px] text-muted">
            Versioned prompt templates for your team.
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            New prompt
          </Button>
        )}
      </header>

      <Input
        placeholder="Search prompts…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        className="max-w-xs"
      />

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn't load prompts" description="Please try again." />
      ) : prompts.length === 0 ? (
        <Empty
          title={search ? 'No prompts match your search' : 'No prompts yet'}
          description={
            search
              ? 'Try a different term.'
              : 'Create your first prompt to start versioning templates.'
          }
          action={
            canWrite && !search ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                New prompt
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {prompts.map((p) => (
            <li key={p.id} className="border-b border-line-soft last:border-b-0">
              <Link
                to={`/prompts/${p.id}`}
                className="flex items-center gap-4 bg-surface px-4 py-3.5 transition-colors hover:bg-elevated"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-[14px] font-medium text-ink">{p.name}</p>
                  {p.description && (
                    <p className="mt-0.5 truncate text-[12.5px] text-muted">{p.description}</p>
                  )}
                </div>
                <span className="ml-auto flex-none text-[12px] text-faint">
                  {timeAgo(p.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

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

      <PromptCreateDialog
        open={creating}
        onOpenChange={setCreating}
        existingNames={prompts.map((p) => p.name)}
      />
    </div>
  );
}
