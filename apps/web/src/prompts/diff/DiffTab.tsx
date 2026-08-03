import { useEffect, useState } from 'react';
import { useDiff, useVersions } from '@/api';
import { cn } from '@/lib/cn';
import { Empty, PageSpinner, Spinner } from '@/ui';

type LineKind = 'add' | 'rem' | 'hunk' | 'meta' | 'ctx';

function classify(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('Index:') || line.startsWith('===')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'rem';
  return 'ctx';
}

const LINE_STYLES: Record<LineKind, string> = {
  add: 'bg-ok-bg text-ok',
  rem: 'bg-danger-bg text-danger',
  hunk: 'text-muted',
  meta: 'text-faint',
  ctx: 'text-muted',
};

/** Version selector for the diff endpoint's `from`/`to`. */
function VersionSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number | null;
  options: number[];
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted">
      {label}
      <select
        value={value ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[13px] text-ink"
      >
        {options.map((n) => (
          <option key={n} value={n}>
            v{n}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Diff tab: pick two versions and view a colored unified diff. */
export function DiffTab({ promptId }: { promptId: string }) {
  const versions = useVersions(promptId);
  const nums = (versions.data?.data ?? []).map((v) => v.versionNumber).sort((a, b) => a - b);

  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  // Seed sensible defaults once versions load: newest vs. the one before it.
  useEffect(() => {
    if (nums.length >= 1 && from === null && to === null) {
      const last = nums[nums.length - 1];
      const prev = nums.length >= 2 ? nums[nums.length - 2] : last;
      setFrom(prev);
      setTo(last);
    }
  }, [nums, from, to]);

  const diff = useDiff(promptId, from, to);

  if (versions.isLoading) return <PageSpinner />;
  if (nums.length < 2) {
    return (
      <Empty
        title="Need two versions to diff"
        description="Commit at least two versions to compare them here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <VersionSelect label="From" value={from} options={nums} onChange={setFrom} />
        <VersionSelect label="To" value={to} options={nums} onChange={setTo} />
        {from === to && <span className="text-[12.5px] text-faint">Pick two different versions.</span>}
      </div>

      {diff.isFetching ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : diff.data ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <pre className="min-w-full font-mono text-[12.5px] leading-relaxed">
            {diff.data.diff.split('\n').map((line, i) => {
              const kind = classify(line);
              return (
                <div key={i} className={cn('px-4 py-px', LINE_STYLES[kind])}>
                  {line || ' '}
                </div>
              );
            })}
          </pre>
        </div>
      ) : from !== to ? (
        <Empty title="No diff" description="These versions may be identical." />
      ) : null}
    </div>
  );
}
