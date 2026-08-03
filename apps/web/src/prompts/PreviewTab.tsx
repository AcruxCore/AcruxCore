import { useMemo, useState } from 'react';
import type { Message } from '@/api';
import { extractVariables, renderMessages } from '@/lib/template';
import { Empty, Field, Input } from '@/ui';

/** Live, client-side preview of the current draft rendered with sample values. */
export function PreviewTab({ draft }: { draft: Message[] }) {
  const [values, setValues] = useState<Record<string, string>>({});

  const variables = useMemo(() => extractVariables(draft), [draft]);

  const rendered = useMemo(() => {
    try {
      return { messages: renderMessages(draft, values), error: null as string | null };
    } catch (e) {
      return {
        messages: [] as Message[],
        error: e instanceof Error ? e.message : 'Template error',
      };
    }
  }, [draft, values]);

  const nonEmptyDraft = draft.some((m) => m.content.trim() !== '');
  if (!nonEmptyDraft) {
    return (
      <Empty
        title="Nothing to preview yet"
        description="Add message content in the Editor tab, then fill any variables here."
      />
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      <div className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
          Variables
        </h3>
        {variables.length === 0 ? (
          <p className="text-[13px] text-muted">This template has no variables.</p>
        ) : (
          variables.map((v) => (
            <Field key={v} label={v} htmlFor={`var-${v}`}>
              <Input
                id={`var-${v}`}
                value={values[v] ?? ''}
                placeholder={`{{ ${v} }}`}
                onChange={(e) => setValues((cur) => ({ ...cur, [v]: e.target.value }))}
              />
            </Field>
          ))
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
          Rendered output
        </h3>
        {rendered.error ? (
          <p className="rounded-md border border-danger/50 bg-danger-bg px-3 py-2 text-[13px] text-danger">
            {rendered.error}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {rendered.messages.map((m, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-line bg-surface">
                <div className="border-b border-line-soft bg-elevated px-3 py-1.5">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                    {m.role}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[13px] leading-relaxed text-ink">
                  {m.content || <span className="text-faint">(empty)</span>}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
