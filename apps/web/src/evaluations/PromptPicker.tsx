import { useRef, useState } from 'react';
import { usePrompts } from '@/api';
import { useClickOutside } from '@/ui';

export interface PromptPickerProps {
  id?: string;
  /** The currently selected prompt, or null for "none selected". */
  value: { id: string; name: string } | null;
  onChange: (prompt: { id: string; name: string } | null) => void;
  placeholder?: string;
}

/**
 * Searchable single-select for choosing one of the team's prompts, backed by
 * `usePrompts`' `search` param. Shared by {@link RuleDrawer}'s prompt-alias
 * filter picker and its judge-prompt picker — both need "find a prompt by
 * name", nothing more prompt-domain-specific than that.
 */
export function PromptPicker({ id, value, onChange, placeholder }: PromptPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false));

  const { data } = usePrompts({ search: query.trim() || undefined });
  const results = data?.data ?? [];

  return (
    <div ref={rootRef} className="relative">
      {value ? (
        <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-ink">
          <span className="flex-1 truncate">{value.name}</span>
          <button
            type="button"
            className="text-faint hover:text-ink"
            aria-label="Clear selected prompt"
            onClick={() => onChange(null)}
          >
            ×
          </button>
        </div>
      ) : (
        <input
          id={id}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder ?? 'Search prompts…'}
          className="w-full rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent"
        />
      )}

      {open && !value && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-line bg-elevated shadow-lg">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-faint">No matching prompts.</p>
          ) : (
            results.map((p) => (
              <button
                key={p.id}
                type="button"
                className="block w-full truncate px-3 py-1.5 text-left text-[13px] text-ink hover:bg-line-soft"
                onClick={() => {
                  onChange({ id: p.id, name: p.name });
                  setQuery('');
                  setOpen(false);
                }}
              >
                {p.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
