import { useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useClickOutside } from './useClickOutside';

export interface MultiSelectOption {
  value: string;
  label?: string;
}

export interface MultiSelectProps {
  id?: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  /** Shown when `options` is empty (e.g. the team has no data for this facet yet). */
  emptyMessage?: string;
}

/**
 * Searchable, scrollable multi-select: a text input that opens a checklist
 * popover filtered by what's typed, with each selection shown as a removable
 * chip. Built in-house — no combobox primitive exists in this UI kit yet —
 * matching {@link Select}'s visual language (border/rounded/text sizing).
 *
 * @param options - Every selectable value, deduplicated by the caller.
 * @param value - Currently selected values (a subset of `options`' `value`s).
 * @param onChange - Called with the full next selection on every toggle.
 */
export function MultiSelect({ id, options, value, onChange, placeholder, emptyMessage }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => (o.label ?? o.value).toLowerCase().includes(q));
  }, [options, query]);

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  function remove(v: string) {
    onChange(value.filter((x) => x !== v));
  }

  return (
    <div ref={rootRef} className="relative">
      <div
        className="flex min-h-[38px] w-full flex-wrap items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1.5 focus-within:border-accent"
        onClick={() => setOpen(true)}
      >
        {value.map((v) => {
          const label = options.find((o) => o.value === v)?.label ?? v;
          return (
            <span
              key={v}
              className="flex items-center gap-1 rounded bg-line-soft px-1.5 py-0.5 text-[12px] text-ink"
            >
              {label}
              <button
                type="button"
                aria-label={`Remove ${label}`}
                className="text-faint hover:text-ink"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(v);
                }}
              >
                ×
              </button>
            </span>
          );
        })}
        <input
          id={id}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={value.length === 0 ? placeholder : undefined}
          className="min-w-[80px] flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
        />
      </div>

      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-line bg-elevated shadow-lg">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-faint">{emptyMessage ?? 'No options yet.'}</p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-faint">No matches.</p>
          ) : (
            filtered.map((o) => (
              <label
                key={o.value}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] text-ink hover:bg-line-soft',
                )}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                  checked={value.includes(o.value)}
                  onChange={() => toggle(o.value)}
                />
                {o.label ?? o.value}
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}
