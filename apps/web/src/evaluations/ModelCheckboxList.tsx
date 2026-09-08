import type { GatewayModel } from '@/api';

/**
 * How many rows fit before the list starts scrolling. Chosen so the list never
 * grows past roughly a third of a dialog: a team that registers twenty models
 * would otherwise push the controls under it off the screen entirely.
 */
const VISIBLE_ROWS = 7;

export interface ModelCheckboxListProps {
  /** The team's registered models, in registry order. */
  models: GatewayModel[];
  /** Selected `publicName`s. */
  selected: Set<string>;
  /** Called with the row's `publicName` and its new checked state. */
  onToggle: (publicName: string, checked: boolean) => void;
  /**
   * Prefix for each row's input id, so two lists on one screen keep distinct
   * ids and their labels stay clickable.
   */
  idPrefix: string;
  'data-testid'?: string;
}

/**
 * The model picker shared by every screen that sweeps a run across models —
 * the experiment config page and both optimize dialogs.
 *
 * It scrolls past {@link VISIBLE_ROWS} rows rather than growing without limit,
 * and once it scrolls it shows a selected count, because a selection that sits
 * below the fold is otherwise invisible: the reader cannot tell a list with two
 * boxes ticked further down from one with none ticked at all.
 */
export function ModelCheckboxList({
  models,
  selected,
  onToggle,
  idPrefix,
  'data-testid': testId,
}: ModelCheckboxListProps) {
  const scrolls = models.length > VISIBLE_ROWS;

  return (
    <div className="flex flex-col gap-1">
      <ul
        className="flex max-h-52 flex-col gap-1.5 overflow-y-auto rounded-md border border-line-soft bg-elevated p-2.5"
        data-testid={testId}
      >
        {models.map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              id={`${idPrefix}-${m.id}`}
              checked={selected.has(m.publicName)}
              onChange={(e) => onToggle(m.publicName, e.target.checked)}
              className="h-4 w-4 shrink-0 accent-varhi"
            />
            <label htmlFor={`${idPrefix}-${m.id}`} className="flex-1 cursor-pointer truncate">
              <span className="font-mono">{m.publicName}</span>
              <span className="ml-2 text-[12px] text-faint">{m.provider}</span>
            </label>
          </li>
        ))}
      </ul>
      {scrolls && (
        <p className="text-[12px] text-faint" data-testid={testId ? `${testId}-count` : undefined}>
          {selected.size} of {models.length} selected · scroll for more
        </p>
      )}
    </div>
  );
}
