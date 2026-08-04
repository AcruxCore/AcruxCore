import { Link } from 'react-router-dom';
import { Empty, PageSpinner } from '@/ui';
import { useDatasets } from '@/api';
import { timeAgo, dateTime } from '@/lib/format';
import { EvaluationsTabs } from './EvaluationsTabs';

/**
 * The `/evaluations` screen: every dataset the team has built (from feedback
 * rows today; more sources land later), newest first. Each row links to the
 * dataset's examples and its "Run experiment" entry point. The run history for
 * those experiments lives on the sibling Runs tab.
 */
export function DatasetsPage() {
  const { data, isLoading, isError } = useDatasets();
  const datasets = data?.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Evaluations</h1>
        <p className="mt-1 text-[13px] text-muted">
          Datasets built from feedback, and the experiments run against them.
        </p>
      </header>

      <EvaluationsTabs active="datasets" />

      {isLoading ? (
        <PageSpinner />
      ) : isError ? (
        <Empty title="Couldn’t load datasets" description="Something went wrong fetching datasets. Try again." />
      ) : datasets.length === 0 ? (
        <Empty
          title="No datasets yet"
          description="Select feedback rows on the Feedback page to build your first dataset."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 text-right font-medium">Examples</th>
                <th className="px-4 py-2.5 text-right font-medium">Created</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
