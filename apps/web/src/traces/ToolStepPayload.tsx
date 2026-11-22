import { useState } from 'react';
import { MonoBlock } from '@/ui';
import { decodePayload, formatPayload } from './format';
import { summarizeJson } from './json-summary';
import { JsonTree } from './JsonTree';
import { KeyValueRows } from './KeyValueRows';
import { RetrievalView } from './RetrievalView';
import { useSearchViewMode, type SearchViewMode } from './use-search-view-mode';
import type { Span } from '@/api/types';

/** Props of {@link ToolStepPayload}. */
export interface ToolStepPayloadProps {
  /** A `tool` or `retrieval` span with a captured payload. */
  span: Span;
  /** Step number lookup, for the "repeated from step N" marks. */
  stepOf: (spanId: string) => number | undefined;
}

/** True for a plain object (not a list, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Small uppercase section label, matching MonoBlock's. */
function Label({ children }: { children: string }) {
  return <div className="text-[11px] uppercase tracking-[0.06em] text-faint">{children}</div>;
}

/** The Documents | JSON switch at the top of a search step. */
function SearchViewSwitch({ mode, onChange }: { mode: SearchViewMode; onChange: (m: SearchViewMode) => void }) {
  const tab = (value: SearchViewMode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      className={`rounded-md px-2.5 py-1 text-[12px] ${mode === value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
      onClick={() => onChange(value)}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Show this search as" className="inline-flex self-start rounded-lg border border-line-soft bg-elevated p-0.5">
      {tab('documents', 'Documents')}
      {tab('json', 'JSON')}
    </div>
  );
}

/**
 * The input and output of a tool or retrieval step, drawn for reading rather than as raw
 * JSON (issue #870). Arguments are a key/value table; the output is a one-line summary
 * plus a tree; a search step shows its query and documents instead. The stored JSON is
 * one click away, unchanged: a search step has a Documents | JSON switch at its top
 * (remembered per browser), any other tool a "Show raw JSON" link.
 *
 * @param props - See {@link ToolStepPayloadProps}.
 * @returns The step's arguments and output, or its raw JSON.
 */
export function ToolStepPayload({ span, stepOf }: ToolStepPayloadProps) {
  const [rawToggled, setRaw] = useState(false);
  const [searchMode, setSearchMode] = useSearchViewMode();
  const isSearch = Boolean(span.retrieval);
  const raw = isSearch ? searchMode === 'json' : rawToggled;
  const payload = span.payload!;
  const input = decodePayload(payload.input);
  const output = decodePayload(payload.output);

  const rawToggle = (
    <button type="button" className="self-start text-[12px] text-accent hover:underline" onClick={() => setRaw((r) => !r)} data-testid="span-raw-toggle">
      {raw ? 'Hide raw JSON' : 'Show raw JSON'}
    </button>
  );

  const searchSwitch = isSearch ? <SearchViewSwitch mode={searchMode} onChange={setSearchMode} /> : null;

  if (raw) {
    return (
      <div className="flex flex-col gap-3">
        {searchSwitch ?? rawToggle}
        {payload.input !== undefined && <MonoBlock label="Input" value={formatPayload(payload.input)} />}
        {payload.output !== undefined && <MonoBlock label="Output" value={formatPayload(payload.output)} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="tool-step-payload">
      {searchSwitch}
      {payload.input !== undefined &&
        (isRecord(input) && Object.keys(input).length > 0 ? (
          <section className="flex flex-col gap-1" data-testid="span-arguments">
            <Label>Arguments</Label>
            <div className="rounded-lg border border-line-soft bg-surface px-3 py-1">
              <KeyValueRows entries={input} />
            </div>
          </section>
        ) : (
          <MonoBlock label="Input" value={formatPayload(payload.input)} />
        ))}

      {span.retrieval ? (
        <RetrievalView view={span.retrieval} stepOf={stepOf} failed={span.status === 'error'} />
      ) : (
        payload.output !== undefined && (
          <section className="flex flex-col gap-1" data-testid="span-output">
            <Label>Output</Label>
            <div className="font-mono text-[12.5px] text-ink" data-testid="span-output-summary">
              {summarizeJson(payload.output)}
            </div>
            {output !== null && typeof output === 'object' ? (
              <JsonTree value={output} />
            ) : (
              <MonoBlock value={formatPayload(payload.output)} />
            )}
          </section>
        )
      )}
      {!isSearch && rawToggle}
    </div>
  );
}
