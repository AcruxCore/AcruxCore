import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Input, Select, Badge } from '@/ui';
import { useTraceFacets, useTraceFacetValues } from '@/api';
import type { TraceFilters as Filters, SpanStatus } from '@/api/types';

const METADATA_PARAM = /^metadata\[(.+)\]$/;

/** Reads every `metadata[key]=value` pair currently in the URL. */
function parseMetadataPairs(sp: URLSearchParams): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [k, v] of sp.entries()) {
    const m = METADATA_PARAM.exec(k);
    if (m) pairs.push([m[1], v]);
  }
  return pairs;
}

/**
 * Parses the current URL search params into a typed TraceFilters object.
 *
 * @param sp - The current `URLSearchParams` (from `useSearchParams`).
 * @returns A `TraceFilters` object; unset params map to `undefined` so the query
 *   builder in `useTraces` drops them from the request.
 */
export function parseTraceFilters(sp: URLSearchParams): Filters {
  const num = (v: string | null) => (v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const tags = sp.getAll('tags');
  const metadataPairs = parseMetadataPairs(sp);
  return {
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    status: (sp.get('status') as SpanStatus) ?? undefined,
    model: sp.get('model') ?? undefined,
    sessionId: sp.get('session_id') ?? undefined,
    promptVersionId: sp.get('prompt_version_id') ?? undefined,
    minLatencyMs: num(sp.get('min_latency_ms')),
    minCostUsd: num(sp.get('min_cost_usd')),
    minTokens: num(sp.get('min_tokens')),
    q: sp.get('q') ?? undefined,
    tags: tags.length > 0 ? tags : undefined,
    metadata: metadataPairs.length > 0 ? Object.fromEntries(metadataPairs) : undefined,
    page: num(sp.get('page')) ?? 1,
    limit: 20,
  };
}

/**
 * One metadata key/value filter row: a key picker + a value input with a remove button.
 *
 * Local draft state holds the picker selection and value text so the trailing "add new"
 * row (which starts with an empty key) can build up a `key=value` pair before committing
 * it to the URL — the key picker stays controlled by the draft, not the (empty) prop, and
 * the value input commits the draft pair on blur/Enter. Committed rows seed their drafts
 * from props and re-sync whenever the URL changes underneath them.
 */
function MetadataRow({
  metaKey,
  value,
  metadataKeys,
  onChange,
  onRemove,
}: {
  metaKey: string;
  value: string;
  metadataKeys: string[];
  onChange: (nextKey: string, nextValue: string) => void;
  onRemove: () => void;
}) {
  const [draftKey, setDraftKey] = useState(metaKey);
  const [draftValue, setDraftValue] = useState(value);
  // Re-sync from props when the URL changes the row out from under us (e.g. a committed
  // row's key/value edited, or the trailing row promoted to a committed row). The trailing
  // row's props stay empty across its own commit, so it clears itself explicitly below.
  useEffect(() => {
    setDraftKey(metaKey);
    setDraftValue(value);
  }, [metaKey, value]);

  const { data: values } = useTraceFacetValues(draftKey || null);
  const listId = `metadata-values-${draftKey || 'new'}`;

  const commit = () => {
    if (draftKey && draftValue) {
      onChange(draftKey, draftValue);
      if (!metaKey) {
        // Trailing "add new" row: clear it so the next pair starts fresh.
        setDraftKey('');
        setDraftValue('');
      }
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Select value={draftKey} onChange={(e) => setDraftKey(e.target.value)} className="max-w-[140px]" data-testid="trace-filter-metadata-key">
        <option value="">Key…</option>
        {metadataKeys.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </Select>
      <Input
        list={listId}
        placeholder="Value…"
        value={draftValue}
        onChange={(e) => setDraftValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="w-32"
        data-testid="trace-filter-metadata-value"
      />
      <datalist id={listId}>
        {(values?.values ?? []).map((v) => <option key={v} value={v} />)}
      </datalist>
      <button type="button" onClick={onRemove} aria-label="Remove metadata filter" className="text-faint hover:text-ink">
        ×
      </button>
    </div>
  );
}

/**
 * The trace filter bar. Every control writes back to the URL query string, which the
 * page reads via `parseTraceFilters` — so back/forward and shareable links just work.
 * Tags and metadata (T8) are populated from `GET /traces/facets` so the pickers reflect
 * whatever the team has actually tagged/annotated, without a hardcoded list.
 */
export function TraceFilters() {
  const [sp, setSp] = useSearchParams();
  const { data: facets } = useTraceFacets();
  const [draftTag, setDraftTag] = useState('');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page'); // any filter change resets pagination
    setSp(next);
  };

  const tags = sp.getAll('tags');
  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    const next = new URLSearchParams(sp);
    next.append('tags', trimmed);
    next.delete('page');
    setSp(next);
    setDraftTag('');
  };
  const removeTag = (tag: string) => {
    const next = new URLSearchParams(sp);
    next.delete('tags');
    for (const t of tags) if (t !== tag) next.append('tags', t);
    next.delete('page');
    setSp(next);
  };

  const metadataPairs = parseMetadataPairs(sp);
  const setMetadataPair = (oldKey: string, nextKey: string, nextValue: string) => {
    const next = new URLSearchParams(sp);
    if (oldKey) next.delete(`metadata[${oldKey}]`);
    if (nextKey && nextValue) next.set(`metadata[${nextKey}]`, nextValue);
    next.delete('page');
    setSp(next);
  };
  const removeMetadataPair = (key: string) => {
    const next = new URLSearchParams(sp);
    next.delete(`metadata[${key}]`);
    next.delete('page');
    setSp(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          placeholder="Search name…"
          defaultValue={sp.get('q') ?? ''}
          onBlur={(e) => set('q', e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)}
          className="w-48"
          data-testid="trace-filter-q"
        />
        <Select value={sp.get('status') ?? ''} onChange={(e) => set('status', e.target.value)} className="max-w-[160px]" data-testid="trace-filter-status">
          <option value="">All statuses</option>
          <option value="ok">OK</option>
          <option value="error">Error</option>
          <option value="unset">Unset</option>
        </Select>
        <Input
          placeholder="Model…"
          defaultValue={sp.get('model') ?? ''}
          onBlur={(e) => set('model', e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && set('model', (e.target as HTMLInputElement).value)}
          className="w-40"
          data-testid="trace-filter-model"
        />
        <Input
          type="date"
          defaultValue={sp.get('from') ?? ''}
          onChange={(e) => set('from', e.target.value)}
          className="w-40"
          aria-label="From date"
          data-testid="trace-filter-from"
        />
        <Input
          type="date"
          defaultValue={sp.get('to') ?? ''}
          onChange={(e) => set('to', e.target.value)}
          className="w-40"
          aria-label="To date"
          data-testid="trace-filter-to"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <Badge key={tag} className="cursor-pointer">
            {tag}
            <button type="button" onClick={() => removeTag(tag)} aria-label={`Remove tag ${tag}`} className="ml-1">
              ×
            </button>
          </Badge>
        ))}
        <Input
          list="trace-tag-options"
          placeholder="Add tag…"
          value={draftTag}
          onChange={(e) => setDraftTag(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTag(draftTag)}
          onBlur={() => draftTag && addTag(draftTag)}
          className="w-32"
          data-testid="trace-filter-tag-input"
        />
        <datalist id="trace-tag-options">
          {(facets?.tags ?? []).filter((t) => !tags.includes(t)).map((t) => <option key={t} value={t} />)}
        </datalist>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {metadataPairs.map(([key, value]) => (
          <MetadataRow
            key={key}
            metaKey={key}
            value={value}
            metadataKeys={facets?.metadataKeys ?? []}
            onChange={(nextKey, nextValue) => setMetadataPair(key, nextKey, nextValue)}
            onRemove={() => removeMetadataPair(key)}
          />
        ))}
        <MetadataRow
          metaKey=""
          value=""
          metadataKeys={facets?.metadataKeys ?? []}
          onChange={(nextKey, nextValue) => setMetadataPair('', nextKey, nextValue)}
          onRemove={() => {}}
        />
      </div>
    </div>
  );
}
