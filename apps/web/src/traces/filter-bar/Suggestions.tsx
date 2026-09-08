import type { ReactNode } from 'react';

export interface Suggestion {
  /** What committing this suggestion types into the bar. */
  value: string;
  /** Primary text shown in the list. */
  label: string;
  /** Short explanation on the right. */
  hint?: string;
}

export interface SuggestionsProps {
  items: Suggestion[];
  /** Index of the keyboard-highlighted row. */
  activeIndex: number;
  onPick: (value: string) => void;
  onHover: (index: number) => void;
  /** Rendered above the list — the "keep typing" line, or nothing. */
  header?: ReactNode;
}

/**
 * The dropdown under the filter input.
 *
 * Rows commit on `mousedown` rather than `click`: the input's blur handler fires
 * first on a click, which closes the popover and cancels the selection before it
 * ever happens.
 *
 * @param items - Suggestions to show, already filtered by the caller.
 * @param activeIndex - Which row the arrow keys have highlighted.
 * @param onPick - Called with the suggestion's `value` when a row is chosen.
 * @param onHover - Called with a row's index when the pointer moves over it.
 * @param header - Optional note rendered above the list.
 * @returns The popover, or null when there is nothing to suggest.
 */
export function Suggestions({ items, activeIndex, onPick, onHover, header }: SuggestionsProps) {
  if (items.length === 0 && !header) return null;

  return (
    <div
      className="absolute left-0 top-full z-30 mt-1 max-h-72 w-full min-w-[280px] overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-2xl"
      data-testid="filter-suggestions"
      role="listbox"
    >
      {header && <div className="px-3 py-1.5 text-[11px] text-faint">{header}</div>}
      {items.map((item, i) => (
        <button
          key={item.value}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-[13px] ${
            i === activeIndex ? 'bg-bg text-ink' : 'text-muted hover:bg-bg'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item.value);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="truncate font-mono text-[12px]">{item.label}</span>
          {item.hint && <span className="shrink-0 text-[11px] text-faint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
