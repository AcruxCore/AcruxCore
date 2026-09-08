import { useState } from 'react';
import { formatPayload } from './format';

/** Below this length a value is short enough to read inline, with no toggle. */
const INLINE_MAX_CHARS = 80;

/**
 * One key/value row. Long or structured values expand in place instead of being
 * truncated with no way to see the rest.
 *
 * This is what made LangChain metadata unreadable: it arrives as a JSON string
 * inside `span.attributes`, and the row rendered it with `truncate` and nothing
 * to click. Expanding runs it through {@link formatPayload}, so nested
 * string-encoded JSON is decoded rather than shown as one escaped line.
 */
function Row({ label, value }: { label: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const text = formatPayload(value);
  const expandable = text.length > INLINE_MAX_CHARS || text.includes('\n');

  if (!expandable) {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-line-soft py-1.5 text-[13px] last:border-0">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-ink">{text}</span>
      </div>
    );
  }

  return (
    <div className="border-b border-line-soft py-1.5 text-[13px] last:border-0">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        data-testid="kv-row-toggle"
      >
        <span className="text-muted">{label}</span>
        <span className="flex min-w-0 items-center gap-2">
          {!expanded && <span className="truncate font-mono text-ink">{text}</span>}
          <span className="shrink-0 text-[12px] text-accent">{expanded ? 'Less' : 'More'}</span>
        </span>
      </button>
      {expanded && (
        <pre className="mt-1.5 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line-soft bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
          {text}
        </pre>
      )}
    </div>
  );
}

export interface KeyValueRowsProps {
  /** The record to render, one row per entry. */
  entries: Record<string, unknown>;
}

/**
 * Renders a record as key/value rows, each one expandable when its value is too
 * long or too structured to read on a single line.
 *
 * Shared by the span panel's Attributes and Metadata sections, which differ only
 * in where their contents come from — platform-written facts versus
 * caller-supplied labels — and not at all in how a value should be read.
 *
 * @param entries - The record to render.
 * @returns One row per entry, in insertion order.
 */
export function KeyValueRows({ entries }: KeyValueRowsProps) {
  return (
    <>
      {Object.entries(entries).map(([k, v]) => (
        <Row key={k} label={k} value={v} />
      ))}
    </>
  );
}
