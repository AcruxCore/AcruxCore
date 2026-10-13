import type { Message, MessageRole } from '@/api';
import { describeContent } from '@/lib/message-content';
import { Button, Select, Textarea } from '@/ui';

const ROLES: MessageRole[] = ['system', 'user', 'assistant'];

export interface DraftMessage {
  role: MessageRole;
  /** Text, or text and image parts; a message with parts is shown read-only here. */
  content: Message['content'];
}

interface MessageListEditorProps {
  messages: DraftMessage[];
  onChange: (i: number, patch: Partial<DraftMessage>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
}

/**
 * The role-select + Textarea + add/remove row editor shared by the Messages
 * tab and the (editable) Stored-prompt tab, so both render identically.
 */
export function MessageListEditor({ messages, onChange, onAdd, onRemove }: MessageListEditorProps) {
  return (
    <div className="flex flex-col gap-2">
      {messages.map((m, i) => (
        <div key={i} className="flex items-start gap-2">
          <Select
            value={m.role}
            onChange={(e) => onChange(i, { role: e.target.value as MessageRole })}
            className="w-32 flex-none"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          {typeof m.content === 'string' ? (
            <Textarea
              value={m.content}
              onChange={(e) => onChange(i, { content: e.target.value })}
              rows={2}
              placeholder="Message content…"
              className="flex-1"
            />
          ) : (
            <div className="flex-1 rounded-md border border-line bg-elevated px-3 py-2">
              <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-ink">
                {describeContent(m.content)}
              </pre>
              <p className="mt-1.5 text-[11.5px] text-faint">
                This message has an image. Edit it in the prompt's Editor tab; it is sent as it is stored.
              </p>
            </div>
          )}
          {messages.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              className="flex-none"
              onClick={() => onRemove(i)}
              aria-label="Remove message"
            >
              ✕
            </Button>
          )}
        </div>
      ))}
      <Button size="sm" variant="ghost" className="self-start" onClick={onAdd}>
        + Add message
      </Button>
    </div>
  );
}
