import { Field, Select } from '@/ui';

/** The server's own default when `draft_count` is omitted. */
export const DEFAULT_DRAFT_COUNT = 3;
/** The server's hard cap (`MAX_DRAFT_COUNT` in the optimize service). */
const MAX_DRAFT_COUNT = 6;

interface DraftCountFieldProps {
  /** DOM id for the select; the label is tied to it. Unique per screen. */
  id: string;
  value: number;
  onChange: (count: number) => void;
}

/**
 * The "Number of rewrites" picker for both screens that start an optimize run
 * (optimize an existing dataset, improve from feedback).
 *
 * Every draft costs one task call and one judge call per example per model, so
 * the hint names that cost: a team whose prompt needs one obvious fix can pick
 * 1 and pay for one candidate instead of three. A select rather than a number
 * input, because the range is small and fixed and nothing out of it is valid.
 *
 * @param props - See {@link DraftCountFieldProps}.
 */
export function DraftCountField({ id, value, onChange }: DraftCountFieldProps) {
  return (
    <Field
      label="Number of rewrites"
      htmlFor={id}
      hint="How many different rewrites the optimizer writes. Each one is run and graded on every example, so more rewrites cost more."
    >
      <Select id={id} aria-label="Number of rewrites" value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: MAX_DRAFT_COUNT }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {n}
            {n === DEFAULT_DRAFT_COUNT ? ' (default)' : ''}
          </option>
        ))}
      </Select>
    </Field>
  );
}
