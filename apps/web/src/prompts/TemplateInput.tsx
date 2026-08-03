import { useRef } from 'react';
import { highlightTemplate } from '@/lib/highlight';
import { cn } from '@/lib/cn';

export interface TemplateInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
}

/**
 * Monospace template editor with live `{{ variable }}` / `{% tag %}` highlighting.
 *
 * A transparent textarea sits over a syntax-colored mirror. The two share the
 * exact font, padding, and wrapping so the caret aligns with the highlighted
 * text; the mirror scrolls in lockstep with the textarea.
 */
export function TemplateInput({
  value,
  onChange,
  placeholder,
  rows = 5,
  id,
}: TemplateInputProps) {
  const mirror = useRef<HTMLPreElement>(null);

  const shared =
    'm-0 w-full whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed';

  return (
    <div className="relative rounded-md border border-line bg-bg focus-within:border-accent">
      <pre
        ref={mirror}
        aria-hidden="true"
        className={cn(shared, 'pointer-events-none overflow-hidden px-3 py-2.5 text-ink')}
      >
        {value ? highlightTemplate(value) : <span className="text-faint">{placeholder}</span>}
        {'\n'}
      </pre>
      <textarea
        id={id}
        data-testid="template-input"
        value={value}
        rows={rows}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (mirror.current) {
            mirror.current.scrollTop = e.currentTarget.scrollTop;
            mirror.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        className={cn(
          shared,
          'absolute inset-0 resize-y bg-transparent px-3 py-2.5 text-transparent caret-ink outline-none',
        )}
      />
    </div>
  );
}
