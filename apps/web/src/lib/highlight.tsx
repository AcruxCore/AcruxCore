import type { ReactNode } from 'react';

const TOKEN = /(\{\{[^}]*\}\}|\{%[^%]*%\}|\{#[^#]*#\})/g;

/**
 * Split template text into React nodes, wrapping nunjucks expressions
 * (`{{ ... }}`), tags (`{% ... %}`) and comments (`{# ... #}`) in colored spans.
 *
 * @param content - Raw template string.
 * @returns An array of strings and highlighted `<span>` nodes, in order.
 */
export function highlightTemplate(content: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(content)) !== null) {
    if (m.index > last) out.push(content.slice(last, m.index));
    const token = m[0];
    const cls = token.startsWith('{{')
      ? 'text-varhi bg-varhi-bg rounded-[3px] px-[2px]'
      : token.startsWith('{#')
        ? 'text-faint italic'
        : 'text-accent';
    out.push(
      <span key={key++} className={cls}>
        {token}
      </span>,
    );
    last = m.index + token.length;
  }
  if (last < content.length) out.push(content.slice(last));
  return out;
}
