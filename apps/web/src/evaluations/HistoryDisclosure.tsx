import type { ChatMessage } from '@/api/types';

/** One message's role + content, rendered as a compact labeled line. */
function MessageLine({ message }: { message: ChatMessage }) {
  return (
    <div className="flex flex-col gap-0.5 rounded border border-line-soft bg-canvas px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-[0.06em] text-faint">{message.role}</span>
      <p className="whitespace-pre-wrap text-[12px] text-ink">
        {message.content ?? (message.tool_calls ? `→ calls ${message.tool_calls.map((t) => t.function.name).join(', ')}` : '')}
      </p>
    </div>
  );
}

/**
 * Collapsed-by-default disclosure showing the prior-turn conversation
 * reconstructed for a dataset example (FAQ Q19). Renders nothing when there
 * is no history, so a single-turn example (the common case) looks identical
 * to before this feature shipped.
 *
 * The summary counts MESSAGES, not turns — one turn is at least a user message
 * plus a reply, and more when it involved tool calls, so a turn count would
 * have to guess where the boundaries are.
 *
 * @param history - The reconstructed history, or null/empty for none.
 */
export function HistoryDisclosure({ history }: { history: ChatMessage[] | null }) {
  if (!history || history.length === 0) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer text-[12px] text-varhi hover:underline">
        {history.length} prior message{history.length === 1 ? '' : 's'}
      </summary>
      <div className="mt-2 flex flex-col gap-1.5">
        {history.map((message, i) => (
          <MessageLine key={i} message={message} />
        ))}
      </div>
    </details>
  );
}
