import { useState } from 'react';

/** Containers at or below this depth start open; deeper ones start closed. */
const OPEN_DEPTH = 1;

/** Children a container draws at first, and how many more each "Show more" adds. */
const PAGE = 100;

/** A scalar, coloured by type so a number and the string "120" look different. */
function Scalar({ value }: { value: unknown }) {
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-words text-ink">"{value}"</span>;
  if (typeof value === 'number') return <span className="text-varhi">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-accent">{String(value)}</span>;
  return <span className="text-faint">null</span>;
}

/** One key and its value; a container value can be opened and closed. */
function Node({ label, value, depth }: { label: string | null; value: unknown; depth: number }) {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const [shown, setShown] = useState(PAGE);

  const key = label !== null && <span className="text-muted">{label}: </span>;
  if (!isObject) {
    return (
      <div className="py-px" style={{ paddingLeft: depth * 14 }} data-json-depth={depth}>
        {key}
        <Scalar value={value} />
      </div>
    );
  }

  const entries: Array<[string, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const count = isArray ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}` : `${entries.length} ${entries.length === 1 ? 'field' : 'fields'}`;
  const hidden = entries.length - shown;
  return (
    <div data-json-depth={depth}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-1 py-px text-left hover:bg-elevated"
        style={{ paddingLeft: depth * 14 }}
      >
        <span className={`inline-block w-3 text-faint transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>›</span>
        {key}
        <span className="text-faint">{isArray ? `[${count}]` : `{${count}}`}</span>
      </button>
      {open && entries.slice(0, shown).map(([k, v]) => <Node key={k} label={k} value={v} depth={depth + 1} />)}
      {open && hidden > 0 && (
        <button
          type="button"
          className="py-px text-accent hover:underline"
          style={{ paddingLeft: (depth + 1) * 14 }}
          onClick={() => setShown((n) => n + PAGE)}
        >
          Show {Math.min(PAGE, hidden)} more of {hidden.toLocaleString('en-US')}
        </button>
      )}
    </div>
  );
}

/**
 * A captured value as a tree you open level by level, instead of one long JSON block.
 * The first level starts open; nested objects and lists show their size and open on
 * click. A container draws its first {@link PAGE} children and offers the rest a page at
 * a time, and the box scrolls inside a fixed height, so a 5,000-row tool output neither
 * builds 5,000 rows nor pushes the feedback controls off screen.
 *
 * @param value - An already-decoded object or array (see `decodePayload`).
 * @returns The tree in a bounded, scrollable box.
 */
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-line-soft bg-bg px-3 py-2 font-mono text-[12px] leading-relaxed" data-testid="json-tree">
      <Node label={null} value={value} depth={0} />
    </div>
  );
}
