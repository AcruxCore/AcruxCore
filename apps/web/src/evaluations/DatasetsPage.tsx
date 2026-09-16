import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, IconButton, PageSpinner, TrashIcon, useToast } from '@/ui';
import { ApiError, useDatasets, useDeleteDataset } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import type { Dataset } from '@/api/types';
import { timeAgo, dateTime } from '@/lib/format';
import { ConfirmDialog } from './ConfirmDialog';
import { EvaluationsTabs } from './EvaluationsTabs';
import { NewDatasetDialog } from './NewDatasetDialog';

/**
 * The `/evaluations` screen: every dataset the team has, newest first. A
 * dataset can be started empty here and filled in by hand, or built from
 * selected feedback rows on the Feedback page — a team with no traffic yet has
 * no feedback, so the empty route in has to exist on this page. Each row links
 * to the dataset's examples and its "Run experiment" entry point; the run
 * history for those experiments lives on the sibling Runs tab.
 */
export function DatasetsPage() {
  const toast = useToast();
  // Evaluation writes are owner/admin/editor server-side. Offering a viewer a button
  // whose request comes back 403 is a worse answer than not offering it.
  const { canWrite } = useAuth();
  const { data, isLoading, isError } = useDatasets();
  const datasets = data?.data ?? [];
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Dataset | null>(null);
  // Keyed by the row awaiting confirmation: the hook is rebuilt whenever that
  // changes, so one instance serves every row without a hook inside the loop.
  const deleteDataset = useDeleteDataset(pendingDelete?.id ?? '');

  async function handleDelete() {
    if (!pendingDelete) return;
    try {
      await deleteDataset.mutateAsync();
      setPendingDelete(null);
      toast.success('Dataset deleted');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete the dataset.');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Datasets</h1>
          <p className="mt-1 text-[13px] text-muted">
            Datasets built from feedback or written by hand, and the experiments run against them.
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-dataset">
            New dataset
          </Button>
        )}
      </header>

      <EvaluationsTabs active="datasets" />

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn’t load datasets" description="Something went wrong fetching datasets. Try again." />
      ) : datasets.length === 0 ? (
        <Empty
          title="No datasets yet"
          description="Create an empty one and add examples by hand, or select feedback rows on the Feedback page to build one from real traffic."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 text-right font-medium">Examples</th>
                <th className="px-4 py-2.5 text-right font-medium">Created</th>
                {canWrite && (
                  <th className="w-10 px-4 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className="border-b border-line-soft bg-surface last:border-b-0 hover:bg-elevated">
                  <td className="px-4 py-2.5">
                    <Link to={`/evaluations/datasets/${d.id}`} className="font-medium text-ink hover:text-accent" data-testid="dataset-row-link">
                      {d.name}
                    </Link>
                    {d.overallFeedback && <p className="mt-0.5 text-[12px] text-muted">{d.overallFeedback}</p>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">{d.exampleCount}</td>
                  <td className="px-4 py-2.5 text-right text-muted" title={dateTime(d.createdAt)}>{timeAgo(d.createdAt)}</td>
                  {canWrite && (
                    <td className="px-4 py-2.5 text-right">
                      <IconButton
                        tone="danger"
                        aria-label={`Delete ${d.name}`}
                        onClick={() => setPendingDelete(d)}
                        data-testid="dataset-row-delete"
                      >
                        <TrashIcon />
                      </IconButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <NewDatasetDialog open={creating} onOpenChange={setCreating} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={pendingDelete ? `Delete \u201C${pendingDelete.name}\u201D?` : 'Delete dataset?'}
        description={
          pendingDelete
            ? `This dataset and its ${pendingDelete.exampleCount} example${pendingDelete.exampleCount === 1 ? '' : 's'} stop appearing anywhere. Past experiment runs against it keep their reports.`
            : ''
        }
        confirmLabel="Delete dataset"
        pending={deleteDataset.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
