import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Empty, PageSpinner } from '@/ui';
import { useDataset } from '@/api';
import { dateTime, timeAgo } from '@/lib/format';
import type { DatasetExample } from '@/api/types';
import { HistoryDisclosure } from './HistoryDisclosure';
import { OptimizeDatasetDialog } from './OptimizeDatasetDialog';

/** Renders an example's `input` variable bag as compact `key: value` pairs. */
function InputPreview({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) return <span className="text-faint">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="font-mono text-[12px]">
          <span className="text-faint">{k}:</span>{' '}
          <span className="text-ink">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
        </div>
      ))}
    </div>
  );
}

/** One row of the examples table. */
function ExampleRow({ example }: { example: DatasetExample }) {
  return (
    <tr className="border-b border-line-soft bg-surface align-top last:border-b-0 hover:bg-elevated">
      <td className="px-4 py-2.5"><InputPreview input={example.input} /></td>
      <td className="px-4 py-2.5 text-ink">{example.criteria ?? <span className="text-faint">—</span>}</td>
      <td className="px-4 py-2.5"><HistoryDisclosure history={example.history} /></td>
      <td className="px-4 py-2.5">
        {example.sourceTraceId ? (
          <Link to={`/traces/${example.sourceTraceId}`} className="font-mono text-[12px] text-varhi hover:underline">
            {example.sourceTraceId.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The `/evaluations/datasets/:id` screen: the dataset's examples (input
 * variables, judge criteria, and a link back to the trace an example was
 * captured from, when there is one), plus the entry point into configuring
 * and starting an experiment against this dataset.
 */
export function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useDataset(id ?? null);
  const [optimizeOpen, setOptimizeOpen] = useState(false);

  if (isLoading) return <PageSpinner />;
  if (isError || !data) {
    return <Empty title="Dataset not found" description="This dataset does not exist or is not in your team." />;
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/evaluations" className="text-[12px] text-muted hover:text-ink">
        ← Datasets
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{data.name}</h1>
          {data.overallFeedback && <p className="mt-1 max-w-xl text-[13px] text-muted">{data.overallFeedback}</p>}
          <div className="mt-2 flex flex-wrap gap-4 text-[13px] text-muted">
            <span>{data.exampleCount} example{data.exampleCount === 1 ? '' : 's'}</span>
            <span title={dateTime(data.createdAt)}>{timeAgo(data.createdAt)}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setOptimizeOpen(true)}>
            Optimize
          </Button>
          <Button variant="primary" onClick={() => navigate(`/evaluations/datasets/${data.id}/run`)}>
            Run experiment
          </Button>
        </div>
      </header>

      {data.examples.length === 0 ? (
        <Empty title="No examples yet" description="This dataset has no examples." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                <th className="px-4 py-2.5 font-medium">Input</th>
                <th className="px-4 py-2.5 font-medium">Criteria</th>
                <th className="px-4 py-2.5 font-medium">History</th>
                <th className="px-4 py-2.5 font-medium">Source trace</th>
              </tr>
            </thead>
            <tbody>
              {data.examples.map((example) => (
                <ExampleRow key={example.id} example={example} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <OptimizeDatasetDialog open={optimizeOpen} onOpenChange={setOptimizeOpen} datasetId={data.id} />
    </div>
  );
}
