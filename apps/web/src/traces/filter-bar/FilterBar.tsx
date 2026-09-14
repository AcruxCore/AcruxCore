import { useId, useMemo, useRef, useState } from 'react';
import { Badge, Input, useClickOutside } from '@/ui';
import { filterPrompts, useAllPrompts, useTraceFacets, useTraceFacetValues } from '@/api';
import {
  applyFilterExpression,
  FILTER_PREFIXES,
  filterStateToParams,
  parseFilterState,
  removeChip,
  stateToChips,
  type FilterState,
} from './chips';
import { Suggestions, type Suggestion } from './Suggestions';
import { SavedViews } from './SavedViews';

/** Prefixes that only mean something on a feedback list. */
const FEEDBACK_ONLY = new Set(['rating:', 'source:', 'label:', 'comment:']);

/** Fixed value sets, so `status:` suggests its three options rather than nothing. */
const ENUM_VALUES: Record<string, string[]> = {
  'status:': ['ok', 'error', 'unset'],
  'rating:': ['up', 'down', 'none'],
  'source:': ['user', 'developer', 'end_user', 'api'],
  'comment:': ['yes', 'no'],
  'warning:': ['yes', 'no'],
  'error_type:': [
    'transport', 'http_status', 'tool_declared', 'schema_mismatch', 'transform', 'provider_error',
  ],
};

export interface FilterBarProps {
  /** The current filters. Controlled — the bar never owns them. */
  value: FilterState;
  onChange: (next: FilterState) => void;
  /**
   * Which list this bar sits on. Decides which prefixes are offered and which
   * saved views are listed.
   */
  surface: 'traces' | 'feedback';
  /** Hides the saved-views menu, for a bar inside a dialog. */
  hideSavedViews?: boolean;
}

/**
 * One typed filter input that replaces a row of separate controls.
 *
 * You type into a single box. It suggests typed prefixes (`tag:`, `prompt:`,
 * `input:`, …) and then their values, drawn from the team's own facets, so most
 * filtering needs no typing beyond the first character. Each committed filter
 * becomes a removable chip; bare text with no prefix becomes an unscoped search.
 *
 * Deliberately controlled and URL-unaware: the two list pages wrap it in
 * {@link useUrlFilterState} so links and back/forward keep working, while the
 * dataset dialog wraps it in plain `useState`, because a dialog's filters have
 * no business in the address bar.
 *
 * Dates stay a separate pair of pickers — typing a date is worse than clicking
 * one.
 *
 * @param value - The current filters.
 * @param onChange - Called with the next filters on every commit or removal.
 * @param surface - `traces` or `feedback`.
 * @param hideSavedViews - Hides the views menu (used inside dialogs).
 * @returns The chip bar, its suggestion popover, and the date range.
 */
export function FilterBar({ value, onChange, surface, hideSavedViews }: FilterBarProps) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Why the last commit applied nothing. Cleared on the next keystroke, so it
  // reads as a response to Enter rather than as a permanent complaint.
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false));

  const { data: facets } = useTraceFacets();

  // Which value list to offer depends on the prefix already typed. A metadata
  // key needs its own request, so it is only asked for once the key is complete.
  const typedPrefix = FILTER_PREFIXES.find((p) => draft.toLowerCase().startsWith(p.prefix))?.prefix;
  const typedValue = typedPrefix ? draft.slice(typedPrefix.length) : '';
  const metaKeyMatch = /^meta\.([^:\s]+):(.*)$/.exec(draft);
  const { data: metaValues } = useTraceFacetValues(metaKeyMatch ? metaKeyMatch[1] : null);
  // The full catalog, not a server search scoped to whatever prefix is being typed: a
  // committed `prompt:` chip can name a prompt that has nothing to do with what's
  // currently typed (or nothing typed at all), and the label lookup below has to resolve
  // it regardless. `filterPrompts` narrows this same list for the suggestion popover.
  const { data: prompts } = useAllPrompts();

  // Chips show a prompt by name, never by UUID.
  const promptLabels = useMemo(
    () => Object.fromEntries((prompts ?? []).map((p) => [p.id, p.name])),
    [prompts],
  );
  const chips = stateToChips(value, { prompts: promptLabels });

  const suggestions: Suggestion[] = useMemo(() => {
    const lower = draft.toLowerCase();

    if (metaKeyMatch) {
      const partial = metaKeyMatch[2].toLowerCase();
      return (metaValues?.values ?? [])
        .filter((v) => v.toLowerCase().includes(partial))
        .slice(0, 8)
        .map((v) => ({ value: `meta.${metaKeyMatch[1]}:${v}`, label: `meta.${metaKeyMatch[1]}:${v}` }));
    }

    if (typedPrefix === 'prompt:') {
      return filterPrompts(prompts ?? [], typedValue)
        .slice(0, 8)
        .map((p) => ({ value: `prompt:${p.id}`, label: `prompt:${p.name}`, hint: 'prompt' }));
    }

    if (typedPrefix === 'tag:') {
      const partial = typedValue.toLowerCase();
      return (facets?.tags ?? [])
        .filter((t) => t.toLowerCase().includes(partial) && !(value.tags ?? []).includes(t))
        .slice(0, 8)
        .map((t) => ({ value: `tag:${t}`, label: `tag:${t}`, hint: 'tag' }));
    }

    if (typedPrefix === 'model:') {
      const partial = typedValue.toLowerCase();
      return (facets?.models ?? [])
        .filter((m) => m.toLowerCase().includes(partial))
        .slice(0, 8)
        .map((m) => ({ value: `model:${m}`, label: `model:${m}`, hint: 'model' }));
    }

    // The only value list that cannot be hardcoded: these slugs are whatever the team's
    // own tools declared, so the suggestions are read back from what was recorded.
    if (typedPrefix === 'error_code:') {
      const partial = typedValue.toLowerCase();
      return (facets?.errorCodes ?? [])
        .filter((c) => c.toLowerCase().includes(partial))
        .slice(0, 8)
        .map((c) => ({ value: `error_code:${c}`, label: `error_code:${c}`, hint: 'declared by a tool' }));
    }

    if (typedPrefix && ENUM_VALUES[typedPrefix]) {
      const partial = typedValue.toLowerCase();
      return ENUM_VALUES[typedPrefix]
        .filter((v) => v.startsWith(partial))
        .map((v) => ({ value: `${typedPrefix}${v}`, label: `${typedPrefix}${v}` }));
    }

    // Nothing typed yet, or a partial prefix: offer the vocabulary itself, plus
    // the team's own metadata keys, which are the half nobody can guess.
    const prefixes: Suggestion[] = FILTER_PREFIXES.filter(
      (p) => (surface === 'feedback' || !FEEDBACK_ONLY.has(p.prefix)) && p.prefix.startsWith(lower),
    ).map((p) => ({ value: p.prefix, label: p.prefix, hint: p.hint }));

    const metaKeys: Suggestion[] = (facets?.metadataKeys ?? [])
      .filter((k) => lower === '' || `meta.${k}:`.startsWith(lower) || k.toLowerCase().includes(lower))
      .map((k) => ({ value: `meta.${k}:`, label: `meta.${k}:`, hint: 'metadata key' }));

    // Metadata keys get their own budget rather than sharing one list's tail.
    // There are seventeen built-in prefixes, so a single slice would push a
    // team's own keys off the bottom every time — and those are the ones nobody
    // can guess.
    return [...prefixes.slice(0, 10), ...metaKeys.slice(0, 4)];
  }, [draft, typedPrefix, typedValue, metaKeyMatch, metaValues, prompts, facets, value.tags, surface]);

  const commit = (text: string) => {
    // A pick that only names a prefix (`tag:`, `score>`, `meta.env:`) is not a
    // filter yet — keep it in the box so the next keystroke supplies the value.
    if (/[:<>]$/.test(text)) {
      setDraft(text);
      setError(null);
      setActiveIndex(0);
      return;
    }
    const { state: next, error: reason } = applyFilterExpression(value, text);
    if (reason) {
      // Nothing applied, so the text stays put and says why. Clearing the box
      // here is what used to make a whole typed string disappear in silence.
      setDraft(text);
      setError(reason);
      setActiveIndex(0);
      return;
    }
    setError(null);
    if (next !== value) onChange(next);
    setDraft('');
    setActiveIndex(0);
    // Close on commit: the popover sits over the results, and the point of
    // committing a filter is to look at what it returned. Clicking the box
    // reopens it to add another.
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = open && suggestions[activeIndex];
      // A highlighted suggestion wins only while the draft is still a prefix.
      // Once a value is typed, Enter must commit what was typed — otherwise
      // typing a phrase and pressing Enter silently searches for something else.
      commit(picked && !typedValue && !metaKeyMatch?.[2] ? picked.value : draft);
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    // Backspace on an empty box removes the last chip, the way every chip input
    // people already use behaves.
    if (e.key === 'Backspace' && draft === '' && chips.length > 0) {
      onChange(removeChip(value, chips[chips.length - 1].key));
    }
  };

  const setDate = (field: 'from' | 'to', next: string) => {
    const updated = { ...value };
    if (next) updated[field] = next;
    else delete updated[field];
    onChange(updated);
  };

  const currentQuery = filterStateToParams(value).toString();

  return (
    <div className="flex flex-col gap-2" data-testid="filter-bar">
      <div className="flex flex-wrap items-center gap-2">
        <div ref={rootRef} className="relative min-w-[280px] flex-1">
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1.5">
            {chips.map((chip) => (
              <Badge key={chip.key} data-testid="filter-chip">
                {chip.label}
                <button
                  type="button"
                  onClick={() => onChange(removeChip(value, chip.key))}
                  aria-label={`Remove filter ${chip.label}`}
                  className="ml-1 text-faint hover:text-ink"
                >
                  ×
                </button>
              </Badge>
            ))}
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
                setOpen(true);
                setActiveIndex(0);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              placeholder={chips.length === 0 ? 'Filter or search — try tag:, prompt:, input:' : ''}
              className="min-w-[120px] flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
              aria-label="Filter traces"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              data-testid="filter-bar-input"
            />
          </div>
          {error && (
            <p
              id={errorId}
              role="alert"
              className="mt-1 text-[12px] text-danger"
              data-testid="filter-bar-error"
            >
              {error}
            </p>
          )}
          {open && (
            <Suggestions
              items={suggestions}
              activeIndex={activeIndex}
              onPick={commit}
              onHover={setActiveIndex}
              header={
                typedPrefix || metaKeyMatch
                  ? undefined
                  : 'Pick a filter, or type any phrase to search names, inputs and outputs.'
              }
            />
          )}
        </div>

        <Input
          type="date"
          value={value.from ?? ''}
          onChange={(e) => setDate('from', e.target.value)}
          className="w-[150px]"
          aria-label="From date"
          data-testid="filter-bar-from"
        />
        <Input
          type="date"
          value={value.to ?? ''}
          onChange={(e) => setDate('to', e.target.value)}
          className="w-[150px]"
          aria-label="To date"
          data-testid="filter-bar-to"
        />

        {!hideSavedViews && (
          <SavedViews
            surface={surface}
            currentQuery={currentQuery}
            onApply={(query) => onChange(parseFilterState(new URLSearchParams(query)))}
          />
        )}
      </div>

      {chips.length > 0 && (
        <button
          type="button"
          className="self-start text-[12px] text-accent hover:underline"
          onClick={() => onChange({})}
          data-testid="filter-bar-clear"
        >
          Clear all filters
        </button>
      )}
    </div>
  );
}
