import type { Message, MessagePart, MessageRole } from '@/api';
import { Button, Input } from '@/ui';
import { TemplateInput } from './TemplateInput';

interface ContentEditorProps {
  role: MessageRole;
  content: Message['content'];
  onChange: (content: Message['content']) => void;
  canWrite: boolean;
}

/**
 * Edits one message's content: a template, or a list of text and image parts.
 *
 * A text-only message looks as it always did. A `user` message gets an "Add image" button that
 * turns it into parts. An image part is a link template such as `{{ receipt_url }}`, so a
 * dataset example or a caller fills it with a variable, the same way a variable fills text.
 */
export function ContentEditor({ role, content, onChange, canWrite }: ContentEditorProps) {
  if (typeof content === 'string') {
    return (
      <div className="flex flex-col gap-2">
        <TemplateInput
          value={content}
          onChange={onChange}
          placeholder="Write the message. Use {{ variables }} and {% logic %}."
        />
        {canWrite && role === 'user' && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange([
                  ...(content.trim() === '' ? [] : [{ type: 'text', text: content } as MessagePart]),
                  { type: 'image_url', image_url: { url: '' } },
                ])
              }
            >
              + Add image
            </Button>
          </div>
        )}
      </div>
    );
  }

  const parts = content;
  function setPart(i: number, part: MessagePart) {
    onChange(parts.map((p, idx) => (idx === i ? part : p)));
  }
  function removePart(i: number) {
    const next = parts.filter((_, idx) => idx !== i);
    // With no image left, a lone text part goes back to a plain string message.
    if (next.length === 1 && next[0]!.type === 'text') onChange(next[0]!.text);
    else onChange(next);
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="content-parts">
      {role !== 'user' && (
        <p className="text-[12px] text-danger">Only a user message can hold an image.</p>
      )}
      {content.map((part, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
              {part.type === 'text' ? 'Text' : 'Image link'}
            </span>
            {canWrite && (
              <button
                type="button"
                onClick={() => removePart(i)}
                className="ml-auto text-[12px] text-faint hover:text-danger"
              >
                Remove
              </button>
            )}
          </div>
          {part.type === 'text' ? (
            <TemplateInput
              value={part.text}
              rows={3}
              onChange={(v) => setPart(i, { type: 'text', text: v })}
              placeholder="Write the text. Use {{ variables }} and {% logic %}."
            />
          ) : (
            <Input
              aria-label="Image link"
              value={part.image_url.url}
              disabled={!canWrite}
              placeholder="https://… or {{ receipt_url }}"
              className="font-mono"
              onChange={(e) =>
                setPart(i, { type: 'image_url', image_url: { ...part.image_url, url: e.target.value } })
              }
            />
          )}
        </div>
      ))}
      {canWrite && (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onChange([...content, { type: 'text', text: '' }])}>
            + Add text
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([...content, { type: 'image_url', image_url: { url: '' } }])}
          >
            + Add image
          </Button>
        </div>
      )}
    </div>
  );
}
