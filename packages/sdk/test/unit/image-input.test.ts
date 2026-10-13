import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { acruxcore } from '../../src/client';
import type { ContentPart, Message, PromptMessage } from '../../src';

/**
 * A typed caller can send an image (issue #573): `Message.content` and `PromptMessage.content`
 * take a list of text and image parts, and `chat()` passes the list to the gateway unchanged.
 */
describe('image input in chat()', () => {
  let hub: acruxcore;
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

  const content: ContentPart[] = [
    { type: 'text', text: 'Read this receipt. Reply with the merchant and the total.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'high' } },
  ];

  beforeEach(() => {
    hub = new acruxcore({ apiKey: 'acx_sk_test', baseUrl: 'https://api.test/api/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'vision-gemma',
          choices: [{ index: 0, message: { role: 'assistant', content: 'BLUE HERON CAFE 12.50' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the parts to the gateway as given and returns the reply as text', async () => {
    const result = await hub.gateway.chat({ model: 'vision-gemma', messages: [{ role: 'user', content }] });

    const sent = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.messages[0].content).toEqual(content);
    // A reply is text, so a caller can use it as a string without narrowing.
    const text: string | null = result.message.content;
    expect(text).toBe('BLUE HERON CAFE 12.50');
    expect(result.content).toBe('BLUE HERON CAFE 12.50');
  });

  it('types a stored prompt message that holds an image link template', () => {
    const stored: PromptMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Read this {{ kind }}.' },
        { type: 'image_url', image_url: { url: '{{ receipt_url }}' } },
      ],
    };
    const message: Message = { role: stored.role, content: stored.content };

    expect(Array.isArray(message.content)).toBe(true);
  });
});
