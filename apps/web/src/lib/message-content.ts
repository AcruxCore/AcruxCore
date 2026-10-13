import type { Message, MessagePart } from '@/api/types';

/**
 * Every template inside a message's content, in order: the string itself, or for a list of parts
 * the text of each text part and the URL of each image part.
 */
export function templatesOf(content: Message['content']): string[] {
  if (typeof content === 'string') return [content];
  return content.map((p) => (p.type === 'text' ? p.text : p.image_url.url));
}

/** Whether a message has nothing to send: blank text and no image URL. */
export function isBlank(content: Message['content']): boolean {
  return templatesOf(content).every((t) => t.trim() === '');
}

/** A one-line-per-part reading of a content, for places that show text only (a diff, a dialog). */
export function describeContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : `[image: ${p.image_url.url}]`)).join('\n');
}

/** Whether a message holds at least one image part. */
export function hasImage(content: Message['content']): boolean {
  return Array.isArray(content) && content.some((p) => p.type === 'image_url');
}

/** Rebuilds a content from the rendered strings that {@link templatesOf} listed for it. */
export function withTemplates(content: Message['content'], rendered: string[]): Message['content'] {
  if (typeof content === 'string') return rendered[0] ?? '';
  return content.map((p, i): MessagePart =>
    p.type === 'text'
      ? { type: 'text', text: rendered[i] ?? '' }
      : { type: 'image_url', image_url: { ...p.image_url, url: rendered[i] ?? '' } },
  );
}

/**
 * Drops what a commit must not send: blank text parts, image parts with no link, and messages
 * left with nothing. A one-part list that is only text becomes a plain string again.
 */
export function withoutBlanks(messages: Message[]): Message[] {
  return messages.flatMap((m): Message[] => {
    if (typeof m.content === 'string') return m.content.trim() === '' ? [] : [m];
    const parts = m.content.filter((p) => (p.type === 'text' ? p.text.trim() !== '' : p.image_url.url.trim() !== ''));
    if (parts.length === 0) return [];
    if (parts.length === 1 && parts[0]!.type === 'text') return [{ ...m, content: parts[0]!.text }];
    return [{ ...m, content: parts }];
  });
}
