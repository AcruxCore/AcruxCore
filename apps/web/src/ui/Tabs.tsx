import { cn } from '@/lib/cn';

export interface TabItem {
  value: string;
  label: string;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * Underlined tab bar. Controlled — the parent owns the active value (typically
 * mirrored to the URL).
 *
 * @param items - Tab definitions (value + label).
 * @param value - The active tab value.
 * @param onChange - Called with the newly selected value.
 */
export function Tabs({ items, value, onChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn('flex gap-1 border-b border-line', className)}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={cn(
              '-mb-px border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-[color]',
              active
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
