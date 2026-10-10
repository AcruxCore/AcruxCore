import { useRef, useState, type DragEvent } from 'react';
import { ApiError, useBulkAddDatasetExamples } from '@/api';
import { Button, DialogFooter, MonoBlock, useToast } from '@/ui';
import { cn } from '@/lib/cn';
import {
  bodyBytes,
  MAX_BODY_BYTES,
  MAX_IMPORT_ROWS,
  parseImportFile,
  SAMPLE_CSV,
  SAMPLE_JSON,
  type ImportParseResult,
} from './dataset-import';

/** How many parsed rows the preview table shows. */
const PREVIEW_ROWS = 5;

/** How many problems are listed before the rest collapse to a count. */
const LISTED_ISSUES = 5;

type SampleFormat = 'csv' | 'json';

/** Saves a sample file through a temporary object URL, so no file has to be served. */
function downloadSample(format: SampleFormat) {
  const blob = new Blob([format === 'csv' ? SAMPLE_CSV : SAMPLE_JSON], {
    type: format === 'csv' ? 'text/csv' : 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dataset-sample.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Renders a cell value compactly: strings as-is, anything else as JSON. */
function cellText(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The format reference shown before a file is chosen. It is visible by default,
 * not behind a link, because the column rules are what decide whether the
 * import works at all.
 */
function FormatHint() {
  const [format, setFormat] = useState<SampleFormat>('csv');
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-bg/40 p-3" data-testid="import-format-hint">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">File format</span>
        <div className="flex gap-1" role="group" aria-label="Sample format">
          {(['csv', 'json'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              aria-pressed={format === f}
              className={cn(
                'rounded px-2 py-0.5 font-mono text-[11px] uppercase',
                format === f ? 'bg-line text-ink' : 'text-muted hover:text-ink',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {format === 'csv' ? (
        <p className="text-[12.5px] leading-relaxed text-muted">
          The first row is the header. Each column becomes an input variable, named after the
          header — so <code className="font-mono text-ink">question</code> fills{' '}
          <code className="font-mono text-ink">{'{{ question }}'}</code> in the prompt. A column
          named <code className="font-mono text-ink">criteria</code> is the judge criteria instead.
          Leave a criteria cell empty for no criteria.
        </p>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-muted">
          A JSON array, one object per example: <code className="font-mono text-ink">input</code>{' '}
          holds the variables, <code className="font-mono text-ink">criteria</code> and{' '}
          <code className="font-mono text-ink">history</code> are optional. Flat objects also work —
          every key other than <code className="font-mono text-ink">criteria</code> and{' '}
          <code className="font-mono text-ink">history</code> is a variable. JSON Lines (
          <code className="font-mono text-ink">.jsonl</code>) is read the same way.
        </p>
      )}
      <MonoBlock value={format === 'csv' ? SAMPLE_CSV.trimEnd() : SAMPLE_JSON.trimEnd()} collapsible={false} />
      <div className="flex items-center justify-between text-[12px] text-faint">
        <span>Up to {MAX_IMPORT_ROWS} rows per file.</span>
        <button
          type="button"
          onClick={() => downloadSample(format)}
          className="text-muted underline-offset-2 hover:text-ink hover:underline"
          data-testid="import-download-sample"
        >
          Download sample .{format}
        </button>
      </div>
    </div>
  );
}

export interface ImportFilePanelProps {
  datasetId: string;
  /** Variable names the dataset's existing examples use, for the mismatch warning. */
  knownVariables?: string[];
  onDone: () => void;
}

/**
 * The "Import file" tab: load a prepared test set from a CSV, JSON or JSONL
 * file, preview it, and add every row in one request.
 *
 * The file is parsed in the browser so problems show up by row number before
 * anything is sent. The API is all-or-nothing, so a file either lands whole or
 * not at all; when some rows have problems the button says how many it will
 * skip, so leaving rows out is always a visible choice.
 */
export function ImportFilePanel({ datasetId, knownVariables, onDone }: ImportFilePanelProps) {
  const toast = useToast();
  const importRows = useBulkAddDatasetExamples(datasetId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportParseResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readFile(file: File) {
    setError(null);
    setFileName(file.name);
    setResult(parseImportFile(file.name, await file.text()));
  }

  function reset() {
    setFileName(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  const rows = result?.rows ?? [];
  const issues = result?.issues ?? [];
  // A header-level problem (row 0) means no row could be read at all.
  const fileLevelIssue = issues.find((i) => i.row === 0);
  const tooMany = rows.length > MAX_IMPORT_ROWS;
  const tooBig = !tooMany && rows.length > 0 && bodyBytes(rows) > MAX_BODY_BYTES;
  const known = new Set(knownVariables ?? []);
  const newVariables = known.size > 0 ? (result?.variables ?? []).filter((v) => !known.has(v)) : [];
  const missingVariables =
    known.size > 0 && result ? [...known].filter((v) => !result.variables.includes(v)) : [];
  // Only multi-turn files get the column, so a plain CSV preview stays narrow.
  const anyHistory = rows.some((row) => row.history !== undefined);
  const canImport = rows.length > 0 && !tooMany && !tooBig && !importRows.isPending;

  async function handleImport() {
    setError(null);
    try {
      const res = await importRows.mutateAsync({ examples: rows });
      toast.success(`Imported ${res.added} example${res.added === 1 ? '' : 's'}`);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not import the file.');
    }
  }

  const importLabel = importRows.isPending
    ? 'Importing…'
    : issues.length > 0 && rows.length > 0
      ? `Import ${rows.length}, skip ${issues.length}`
      : `Import ${rows.length} example${rows.length === 1 ? '' : 's'}`;

  return (
    <div className="flex flex-col gap-3">
      {!result ? (
        <>
          <FormatHint />
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition-colors',
              dragging ? 'border-varhi bg-varhi-bg' : 'border-line hover:border-muted',
            )}
            data-testid="import-dropzone"
          >
            <span className="text-[13px] font-medium text-ink">Choose a file or drop it here</span>
            <span className="text-[12px] text-faint">.csv, .json or .jsonl</span>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.json,.jsonl,.ndjson,text/csv,application/json"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
              data-testid="import-file-input"
            />
          </label>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate">
              <span className="font-mono text-ink">{fileName}</span>
              <span className="text-muted">
                {' '}
                · {rows.length} row{rows.length === 1 ? '' : 's'} ready
                {issues.length > 0 && !fileLevelIssue && (
                  <span className="text-danger">
                    {' '}
                    · {issues.length} with problems
                  </span>
                )}
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={reset} data-testid="import-choose-another">
              Choose another file
            </Button>
          </div>

          {issues.length > 0 && (
            <ul className="flex flex-col gap-0.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger" data-testid="import-issues">
              {issues.slice(0, LISTED_ISSUES).map((issue, i) => (
                <li key={i}>{issue.row === 0 ? issue.message : `Row ${issue.row} ${issue.message}`}</li>
              ))}
              {issues.length > LISTED_ISSUES && <li>…and {issues.length - LISTED_ISSUES} more.</li>}
            </ul>
          )}

          {tooMany && (
            <p className="text-[12px] text-danger">
              {rows.length} rows is more than {MAX_IMPORT_ROWS} per import. Split the file and import it in parts.
            </p>
          )}
          {tooBig && (
            <p className="text-[12px] text-danger">
              This file is larger than 1 MB once sent. Split it and import it in parts.
            </p>
          )}

          {(newVariables.length > 0 || missingVariables.length > 0) && (
            <p className="rounded-lg border border-line-soft px-3 py-2 text-[12px] text-muted" data-testid="import-variable-warning">
              This dataset's examples use{' '}
              <span className="font-mono text-ink">{[...known].join(', ')}</span>.
              {newVariables.length > 0 && (
                <>
                  {' '}
                  The file adds <span className="font-mono text-ink">{newVariables.join(', ')}</span>.
                </>
              )}
              {missingVariables.length > 0 && (
                <>
                  {' '}
                  It has no <span className="font-mono text-ink">{missingVariables.join(', ')}</span>.
                </>
              )}{' '}
              A prompt run against this dataset renders missing variables as empty.
            </p>
          )}

          {rows.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="max-h-[260px] overflow-auto rounded-lg border border-line">
                <table className="w-full border-collapse text-left text-[12px]" data-testid="import-preview">
                  <thead>
                    <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                      <th className="px-3 py-2 font-medium" title="Row number in your file">Row</th>
                      {result.variables.map((v) => (
                        <th key={v} className="px-3 py-2 font-mono font-medium normal-case tracking-normal">
                          {v}
                        </th>
                      ))}
                      <th className="px-3 py-2 font-medium">Criteria</th>
                      {anyHistory && <th className="px-3 py-2 font-medium">History</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                      <tr key={i} className="border-b border-line-soft align-top last:border-0">
                        <td className="px-3 py-1.5 text-faint">{result.rowNumbers[i]}</td>
                        {result.variables.map((v) => (
                          <td key={v} className="max-w-[220px] truncate px-3 py-1.5 text-ink" title={cellText(row.input[v])}>
                            {cellText(row.input[v])}
                          </td>
                        ))}
                        <td className="max-w-[260px] truncate px-3 py-1.5 text-muted" title={row.criteria}>
                          {row.criteria ?? <span className="text-faint">—</span>}
                        </td>
                        {anyHistory && (
                          <td className="whitespace-nowrap px-3 py-1.5 text-muted">
                            {row.history ? `${row.history.length} message${row.history.length === 1 ? '' : 's'}` : '—'}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > PREVIEW_ROWS && (
                <span className="text-[11.5px] text-faint">
                  Showing the first {PREVIEW_ROWS} of {rows.length} rows.
                </span>
              )}
            </div>
          )}
        </>
      )}

      {error && <p className="text-[12px] text-danger">{error}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canImport} onClick={handleImport} data-testid="import-submit">
          {importLabel}
        </Button>
      </DialogFooter>
    </div>
  );
}
