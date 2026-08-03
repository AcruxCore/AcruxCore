import { Link } from 'react-router-dom';
import type { Message, MessageRole } from '@/api';
import { Button } from '@/ui';
import { TemplateInput } from './TemplateInput';

const ROLES: MessageRole[] = ['system', 'user', 'assistant'];

export interface EditorTabProps {
  draft: Message[];
  onChange: (draft: Message[]) => void;
  canWrite: boolean;
  onCommit: () => void;
  committing: boolean;
  dirty: boolean;
  /** Registered gateway models to bind a default from (#12). */
  models: { id: string; publicName: string }[];
  /** Currently-selected default model publicName, or null for unbound (#12). */
  model: string | null;
  /** Called when the user changes the default-model binding (#12). */
  onModelChange: (model: string | null) => void;
}

/**
 * Draft editor for a prompt's messages. Each message has a role and a nunjucks
 * template body; commit creates a new immutable version. Read-only for viewers.
 */
export function EditorTab({
  draft,
  onChange,
  canWrite,
  onCommit,
  committing,
  dirty,
  models,
  model,
  onModelChange,
}: EditorTabProps) {
  function update(i: number, patch: Partial<Message>) {
    onChange(draft.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function remove(i: number) {
    onChange(draft.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...draft, { role: 'user', content: '' }]);
  }

  const hasContent = draft.some((m) => m.content.trim() !== '');

  return (
    <div className="flex flex-col gap-4">
      {!canWrite && (
        <p className="rounded-md border border-line bg-elevated px-3 py-2 text-[12.5px] text-muted">
          Your role is read-only. You can view and preview, but not commit versions.
        </p>
      )}

      {/* Default-model binding (#12): lives on the version, so it's set here at
          commit time. The Playground auto-selects whatever is bound. */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
        <label htmlFor="editor-default-model" className="text-[12.5px] font-medium text-muted">
          Default model
        </label>
        {models.length > 0 ? (
          <>
            <select
              id="editor-default-model"
              value={model ?? ''}
              disabled={!canWrite}
              onChange={(e) => onModelChange(e.target.value || null)}
              className="rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] text-ink disabled:opacity-60"
            >
              <option value="">No default model</option>
              {models.map((m) => (
                <option key={m.id} value={m.publicName}>
                  {m.publicName}
                </option>
              ))}
            </select>
            <span className="text-[11.5px] text-faint">
              Binds to the next version you commit; the Playground pre-selects it.
            </span>
          </>
        ) : (
          <span className="text-[11.5px] text-faint">
            No gateway models registered —{' '}
            <Link to="/gateway/models" className="text-accent hover:underline">
              add one
            </Link>{' '}
            to bind a default.
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {draft.map((m, i) => (
          <div key={i} className="overflow-hidden rounded-md border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line-soft bg-elevated px-3 py-2">
              <select
                value={m.role}
                disabled={!canWrite}
                onChange={(e) => update(i, { role: e.target.value as MessageRole })}
                className="rounded border border-line bg-bg px-2 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted disabled:opacity-60"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {canWrite && draft.length > 1 && (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="ml-auto text-[12px] text-faint hover:text-danger"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="p-3">
              <TemplateInput
                value={m.content}
                onChange={(v) => update(i, { content: v })}
                placeholder="Write the message. Use {{ variables }} and {% logic %}."
              />
            </div>
          </div>
        ))}
      </div>

      {canWrite && (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={add}>
            + Add message
          </Button>
          <Button
            variant="primary"
            className="ml-auto"
            disabled={committing || !hasContent || !dirty}
            onClick={onCommit}
            title={!dirty ? 'No changes since the last version' : undefined}
          >
            {committing ? 'Committing…' : 'Commit new version'}
          </Button>
        </div>
      )}
    </div>
  );
}
