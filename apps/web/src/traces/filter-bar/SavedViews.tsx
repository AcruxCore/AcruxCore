import { useRef, useState } from 'react';
import { Button, Input, useClickOutside, useToast } from '@/ui';
import { useCreateSavedView, useDeleteSavedView, useSavedViews } from '@/api';
import { ApiError } from '@/api';

export interface SavedViewsProps {
  /** Which list these views belong to. */
  surface: 'traces' | 'feedback';
  /** The current filters as a query string, saved verbatim. */
  currentQuery: string;
  /** Applies a saved view's stored query string to the page. */
  onApply: (query: string) => void;
}

/**
 * The saved-views menu beside the filter bar.
 *
 * A view stores the raw query string, so applying one is a string hand-off and
 * nothing has to stay in sync with the grammar. Views are team-visible and any
 * member can delete one — see the API's ViewsService for why.
 *
 * @param surface - The list these views belong to.
 * @param currentQuery - The filters to store when saving.
 * @param onApply - Called with a stored query string when a view is picked.
 * @returns A dropdown button listing the team's views for this surface.
 */
export function SavedViews({ surface, currentQuery, onApply }: SavedViewsProps) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  useClickOutside(rootRef, () => {
    setOpen(false);
    setNaming(false);
  });

  const { data } = useSavedViews(surface);
  const create = useCreateSavedView(surface);
  const remove = useDeleteSavedView(surface);
  const views = data?.data ?? [];

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(
      { surface, name: trimmed, query: currentQuery },
      {
        onSuccess: () => {
          setName('');
          setNaming(false);
          toast.success(`Saved “${trimmed}”`);
        },
        onError: (err) => {
          // 409 is the one error worth its own words: the fix is a different
          // name, not a retry.
          toast.error(
            err instanceof ApiError && err.status === 409
              ? 'A view with that name already exists.'
              : 'Could not save this view',
          );
        },
      },
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="saved-views-toggle"
      >
        Views {views.length > 0 && <span className="text-faint">({views.length})</span>}
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-line bg-surface py-1 shadow-2xl"
          data-testid="saved-views-menu"
        >
          {views.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-faint">
              No saved views yet. Filter the list, then save it under a name.
            </p>
          ) : (
            views.map((view) => (
              <div key={view.id} className="flex items-center gap-2 px-1">
                <button
                  type="button"
                  className="flex-1 truncate rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-bg"
                  onClick={() => {
                    onApply(view.query);
                    setOpen(false);
                  }}
                  data-testid="saved-view-apply"
                >
                  {view.name}
                </button>
                <button
                  type="button"
                  className="px-2 text-faint hover:text-danger"
                  aria-label={`Delete view ${view.name}`}
                  onClick={() =>
                    remove.mutate(view.id, { onError: () => toast.error('Could not delete this view') })
                  }
                >
                  ×
                </button>
              </div>
            ))
          )}

          <div className="mt-1 border-t border-line-soft px-2 pb-1 pt-2">
            {naming ? (
              <div className="flex items-center gap-1.5">
                <Input
                  autoFocus
                  value={name}
                  placeholder="Name this view…"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save();
                    if (e.key === 'Escape') setNaming(false);
                  }}
                  className="flex-1"
                  data-testid="saved-view-name"
                />
                <Button size="sm" variant="primary" onClick={save} disabled={create.isPending}>
                  Save
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="w-full"
                onClick={() => setNaming(true)}
                disabled={!currentQuery}
                title={currentQuery ? undefined : 'Add a filter first'}
                data-testid="saved-view-start"
              >
                Save current filters
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
