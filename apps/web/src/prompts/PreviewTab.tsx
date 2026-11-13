import { useMemo, useState } from 'react';
import { usePreviewRender, type Message } from '@/api';
import { extractVariables, parsePreviewValues } from '@/lib/template';
import { isBlank } from '@/lib/message-content';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { Empty, Field, Input } from '@/ui';

/** Quiet time after the last keystroke before the draft is sent to be rendered. */
const PREVIEW_DEBOUNCE_MS = 300;

/**
 * Live preview of the current draft rendered with sample values.
 *
 * The page only parses the draft, to list its variables. The render itself runs on the
 * server, in the API's template sandbox (`usePreviewRender`), because the draft can be a
 * teammate's stored template and rendering it in the page would run its code here.
 */
export function PreviewTab({ promptId, draft }: { promptId: string; draft: Message[] }) {
  const [values, setValues] = useState<Record<string, string>>({});

  const variables = useMemo(() => extractVariables(draft), [draft]);
  const input = useMemo(() => ({ draft, values: parsePreviewValues(values) }), [draft, values]);
  const debounced = useDebouncedValue(input, PREVIEW_DEBOUNCE_MS);
  const nonEmptyDraft = draft.some((m) => !isBlank(m.content));
  const preview = usePreviewRender(promptId, debounced.draft, debounced.values, nonEmptyDraft);

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
          <>
            <p className="text-[12px] text-muted" data-testid="preview-json-hint">
              For a list or object, type JSON, such as <code className="font-mono">["a", "b"]</code>.
            </p>
            {variables.map((v) => (
              <Field key={v} label={v} htmlFor={`var-${v}`}>
                <Input
                  id={`var-${v}`}
                  value={values[v] ?? ''}
                  placeholder={`{{ ${v} }}`}
                  onChange={(e) => setValues((cur) => ({ ...cur, [v]: e.target.value }))}
                />
              </Field>
            ))}
          </>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
          Rendered output
        </h3>
        {preview.isError ? (
          <p className="whitespace-pre-wrap rounded-md border border-danger/50 bg-danger-bg px-3 py-2 text-[13px] text-danger">
            {preview.error instanceof Error ? preview.error.message : 'Template error'}
          </p>
        ) : !preview.data ? (
          <p className="text-[13px] text-muted">Rendering…</p>
        ) : (
          <div className="flex flex-col gap-3">
            {preview.data.messages.map((m, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-line bg-surface">
                <div className="border-b border-line-soft bg-elevated px-3 py-1.5">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                    {m.role}
                  </span>
                </div>
                {typeof m.content === 'string' ? (
                  <pre className="whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[13px] leading-relaxed text-ink">
                    {m.content || <span className="text-faint">(empty)</span>}
                  </pre>
                ) : (
                  <div className="flex flex-col gap-3 px-3.5 py-3">
                    {m.content.map((part, j) =>
                      part.type === 'text' ? (
                        <pre
                          key={j}
                          className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-ink"
                        >
                          {part.text || <span className="text-faint">(empty)</span>}
                        </pre>
                      ) : /^(https?:\/\/|data:image\/)/i.test(part.image_url.url) ? (
                        <img
                          key={j}
                          src={part.image_url.url}
                          alt="Rendered image part"
                          className="max-h-64 max-w-full self-start rounded border border-line"
                        />
                      ) : (
                        <p key={j} className="font-mono text-[12.5px] text-faint">
                          Image link: {part.image_url.url || '(empty — fill the variable above)'}
                        </p>
                      ),
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
