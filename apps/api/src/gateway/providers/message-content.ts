import type { ChatMessage, ContentPart, ImageContentPart } from './types';

/** Matches `data:image/<subtype>;base64,<payload>`, capturing the subtype and the payload. */
const DATA_IMAGE_URL = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is;

/**
 * Joins the text of a message's content.
 *
 * A string is returned as is. An array yields its text parts joined by a newline; image parts
 * contribute nothing, because every caller of this wants the words (a trace preview, a system
 * prompt, a token estimate of the text) and handles images on its own path.
 *
 * @param content - A message's `content`.
 * @returns The text, or `''` for `null`.
 */
export function contentText(content: ChatMessage['content']): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Splits a `data:image/...;base64,...` URL.
 *
 * @param url - An image part's `url`.
 * @returns The media type and base64 payload, or `null` for a remote URL.
 */
export function parseDataImageUrl(url: string): { mediaType: string; data: string } | null {
  const match = DATA_IMAGE_URL.exec(url);
  return match ? { mediaType: match[1]!.toLowerCase(), data: match[2]! } : null;
}

/** Whether `part` is an image part. */
export function isImagePart(part: ContentPart): part is ImageContentPart {
  return part.type === 'image_url';
}
