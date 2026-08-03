import { useState } from 'react';
import { MonoBlock, Textarea } from '@/ui';
import type { PendingToolCall } from './tool-loop';

/**
 * Live resolution state of one tool call in the Playground's tool-calling
 * loop: `running` while an `http` tool is being auto-executed, `manual`
 * while it waits for a hand-typed result (a `client` tool, or a call naming
 * a tool that isn't attached/executable), `done` once a result exists, and
 * `error` when an auto-run attempt failed (offers "Re-run").
 */
export type ToolCallStatus = 'running' | 'manual' | 'done' | 'error';

interface ToolCallCardProps {
  /** The model's call: name + parsed arguments. */
  call: PendingToolCall;
  /** Current resolution state driving which controls/content render. */
  status: ToolCallStatus;
  /** The resolved result content, once `status === 'done'`. */
  result: string | null;
  /** The last execution error, when `status === 'error'`. */
  error?: string | null;
  /** Retries an auto-run call after a failure. Omit to hide the "Re-run" button. */
  onRerun?: () => void;
  /** Submits a hand-typed result for a `manual` call. Omit to hide the textarea. */
  onManualSubmit?: (value: string) => void;
}

/**
 * One card per model-requested tool call: its name, its arguments, and how
 * it resolved. `http` tools auto-execute (with a "Re-run" action on
 * failure); everything else — `client` tools and calls naming a tool the
 * user never attached — gets an editable textarea so the user can supply
 * the result by hand before the loop continues.
 *
 * @param call - The call's name and arguments.
 * @param status - Its current resolution state.
 * @param result - The resolved result content, once done.
 * @param error - The last execution error, if any.
 * @param onRerun - Retry handler for a failed auto-run call.
 * @param onManualSubmit - Submit handler for a hand-typed result.
 * @returns A bordered card showing the call, its arguments, and its outcome.
 */
export function ToolCallCard({ call, status, result, error, onRerun, onManualSubmit }: ToolCallCardProps) {
  const [draft, setDraft] = useState('');

  const badge =
    status === 'running'
      ? 'running…'
      : status === 'manual'
        ? 'needs input'
        : status === 'error'
          ? 'error'
          : 'done';

  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[13px] text-ink">{call.name}</span>
        <span className="text-[11px] uppercase tracking-wide text-faint">{badge}</span>
        {status === 'error' && onRerun && (
          <button
            type="button"
            className="ml-auto text-[12px] text-accent hover:underline"
            onClick={onRerun}
          >
            Re-run
          </button>
        )}
      </div>

      <MonoBlock className="mt-2" label="Arguments" value={JSON.stringify(call.arguments, null, 2)} />

      {status === 'error' && error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}

      {status === 'manual' && onManualSubmit ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            mono
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste this tool's result…"
            className="text-[12px]"
          />
          <button
            type="button"
            disabled={draft.trim() === ''}
            onClick={() => onManualSubmit(draft)}
            className="self-start rounded-md border border-line px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
          >
            Use this result
          </button>
        </div>
      ) : status === 'done' && result !== null ? (
        <MonoBlock className="mt-2" label="Result" value={result} />
      ) : status === 'running' ? (
        <p className="mt-2 text-[12.5px] text-faint">Running…</p>
      ) : null}
    </div>
  );
}
