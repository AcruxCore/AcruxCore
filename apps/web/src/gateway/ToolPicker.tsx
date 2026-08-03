import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolSummary } from '@/api';

interface ToolPickerProps {
  /** All tools available to attach, from the catalog. */
  tools: ToolSummary[];
  /** Ids of the tools currently attached to the request. */
  selectedIds: string[];
  /** Called with the next selected-id set whenever the user toggles a tool. */
  onChange: (ids: string[]) => void;
  /** Disables the trigger and clears removal (e.g. while a run is in flight). */
  disabled?: boolean;
}

/**
 * Multi-select tool attach control: a dropdown button that opens a searchable,
 * scrollable checkbox list, with the chosen tools shown as removable chips
 * below. Replaces the flat chip row, which grew unwieldy once a team has many
 * tools.
 *
 * @param tools - The full catalog of attachable tools.
 * @param selectedIds - Ids currently attached.
 * @param onChange - Receives the next id set on every toggle/clear.
 * @param disabled - When true, the trigger and chip removal are inert.
 */
export function ToolPicker({ tools, selectedIds, onChange, disabled }: ToolPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape (mirrors the Save menu's pattern).
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedTools = tools.filter((t) => selectedSet.has(t.id));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) => t.name.toLowerCase().includes(q));
  }, [tools, query]);

  function toggle(id: string) {
    onChange(selectedSet.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  }

  const summary =
    selectedTools.length === 0
      ? 'Select tools…'
      : `${selectedTools.length} tool${selectedTools.length === 1 ? '' : 's'} selected`;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">Tools</span>

      <div ref={rootRef} className="relative w-full max-w-md">
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={[
            'flex w-full items-center justify-between gap-2 rounded-md border bg-bg px-3 py-2 text-left text-[13px]',
            'transition-colors focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            selectedTools.length > 0 ? 'border-line text-ink' : 'border-line text-muted',
          ].join(' ')}
        >
          <span className="truncate">{summary}</span>
          <svg
            aria-hidden="true"
            className="flex-none text-faint"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {open && (
          <div
            role="listbox"
            className="absolute left-0 top-full z-20 mt-1 w-full min-w-[240px] rounded-md border border-line bg-surface py-1 shadow-lg"
          >
            <div className="px-2 pb-1.5 pt-1">
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tools…"
                className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-faint">No tools match “{query}”.</p>
              ) : (
                filtered.map((t) => {
                  const on = selectedSet.has(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => toggle(t.id)}
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-elevated"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        readOnly
                        tabIndex={-1}
                        className="h-3.5 w-3.5 flex-none accent-[var(--accent)]"
                      />
                      <span className="truncate font-mono text-[12px] text-ink">{t.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {selectedTools.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedTools.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-accent px-2.5 py-1 font-mono text-[12px] text-accent"
            >
              {t.name}
              <button
                type="button"
                disabled={disabled}
                onClick={() => toggle(t.id)}
                aria-label={`Remove ${t.name}`}
                className="text-accent/70 transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
