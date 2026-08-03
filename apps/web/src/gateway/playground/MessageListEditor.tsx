import type { MessageRole } from '@/api';
import { Button, Select, Textarea } from '@/ui';

const ROLES: MessageRole[] = ['system', 'user', 'assistant'];

export interface DraftMessage {
  role: MessageRole;
  content: string;
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
          <Textarea
            value={m.content}
            onChange={(e) => onChange(i, { content: e.target.value })}
            rows={2}
            placeholder="Message content…"
            className="flex-1"
          />
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
