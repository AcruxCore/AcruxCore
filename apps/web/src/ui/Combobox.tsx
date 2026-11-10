import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { useClickOutside } from './useClickOutside';

export interface ComboboxOption {
  value: string;
}

export interface ComboboxProps {
  id?: string;
  options: ComboboxOption[];
  /** The current text. It need not be one of `options`: free text is allowed. */
  value: string;
  /** Called on every keystroke and on every pick, with the new text. */
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/** Most rows rendered at once. Typing narrows a long list, so nobody scrolls past this. */
const MAX_ROWS = 200;

/** Splits a case-insensitive filter on spaces, so "gpt mini" matches "gpt-4o-mini". */
function matches(value: string, query: string): boolean {
  const v = value.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => v.includes(part));
}

/**
 * A text input with a searchable list under it, for picking one value from a long
 * list while still allowing a value the list does not have.
 *
 * Built in-house, like {@link MultiSelect}: the native `<datalist>` looks different
 * in every browser and ignores the dark theme. Arrow keys move through the rows, Enter
 * picks, Escape closes. When the typed text matches no row exactly, a "Use …" row lets
 * the user keep it as typed.
 *
 * @param options - Every selectable value.
 * @param value - The current text.
 * @param onChange - Receives the text after each keystroke or pick.
 */
export function Combobox({ id, options, value, onChange, placeholder, className }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useClickOutside(rootRef, () => setOpen(false));

  const filtered = useMemo(() => {
    const q = value.trim();
    const hits = q ? options.filter((o) => matches(o.value, q)) : options;
    return hits.slice(0, MAX_ROWS);
  }, [options, value]);

  const typed = value.trim();
  const showCustom = typed !== '' && !options.some((o) => o.value === typed);
  const rowCount = filtered.length + (showCustom ? 1 : 0);

  // A new filter starts at the top row.
  useEffect(() => setActive(0), [value]);

  // Keeps the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(rowCount - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && rowCount > 0) {
      e.preventDefault();
      pick(active < filtered.length ? filtered[active].value : typed);
    } else if (e.key === 'Escape' && open) {
      // Stops here so the surrounding dialog does not close too.
      e.stopPropagation();
      setOpen(false);
    }
  }

  const listId = id ? `${id}-list` : undefined;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
      />
      {open && rowCount > 0 && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-elevated py-1 shadow-lg"
        >
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={i === active}
              data-row={i}
              // mousedown, not click: a click fires after the input's blur and the list is gone.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.value);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex cursor-pointer items-center gap-3 px-3 py-1.5 text-[13px]',
                i === active ? 'bg-line-soft text-ink' : 'text-ink',
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{o.value}</span>
            </li>
          ))}
          {showCustom && (
            <li
              role="option"
              aria-selected={active === filtered.length}
              data-row={filtered.length}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(typed);
              }}
              onMouseEnter={() => setActive(filtered.length)}
              className={cn(
                'cursor-pointer border-t border-line-soft px-3 py-1.5 text-[13px] text-muted',
                active === filtered.length && 'bg-line-soft text-ink',
              )}
            >
              Use <span className="font-mono text-ink">{typed}</span> as typed
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
