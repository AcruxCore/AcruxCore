import { describe, expect, it } from 'vitest';
import type { Message } from '@/api/types';
import { describeContent, isBlank, withoutBlanks } from './message-content';
import { extractVariables, renderMessages } from './template';

const RECEIPT: Message = {
  role: 'user',
  content: [
    { type: 'text', text: 'Read this {{ kind }}.' },
    { type: 'image_url', image_url: { url: '{{ receipt_url }}', detail: 'high' } },
  ],
};

describe('a message with an image part (issue #573)', () => {
  it('lists the variables of its text and of its image link', () => {
    expect(extractVariables([RECEIPT])).toEqual(['kind', 'receipt_url']);
  });

  it('renders the text and the image link, and keeps the detail field', () => {
    const [out] = renderMessages([RECEIPT], { kind: 'receipt', receipt_url: 'https://x.test/a.png' });

    expect(out!.content).toEqual([
      { type: 'text', text: 'Read this receipt.' },
      { type: 'image_url', image_url: { url: 'https://x.test/a.png', detail: 'high' } },
    ]);
  });

  it('reads as text with the image link on its own line', () => {
    expect(describeContent(RECEIPT.content)).toBe('Read this {{ kind }}.\n[image: {{ receipt_url }}]');
  });

  it('counts an image with a link as content, and an empty image as blank', () => {
    expect(isBlank(RECEIPT.content)).toBe(false);
    expect(isBlank([{ type: 'image_url', image_url: { url: ' ' } }])).toBe(true);
  });

  it('drops blank parts and empty messages before a commit, and turns a lone text part back into a string', () => {
    const cleaned = withoutBlanks([
      { role: 'system', content: '  ' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'image_url', image_url: { url: '' } }] },
      { role: 'user', content: [{ type: 'text', text: '' }, { type: 'image_url', image_url: { url: '{{ u }}' } }] },
    ]);

    expect(cleaned).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: '{{ u }}' } }] },
    ]);
  });
});
