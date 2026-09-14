import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { acruxcore } from '../../src/client';
import { acrux } from '../../src/tools';

/**
 * `gateway.chat` rejects a declared tool instead of sending it.
 *
 * `chat()` and `runToolLoop()` both take `tools`, and they mean different things by it:
 * raw OpenAI definitions here, `acrux.tool` declarations there. The wrong one used to
 * reach the server and come back as `400 Invalid literal value, expected "function"`,
 * which names neither the field nor the call that would have worked.
 */
describe('chat() tool shape', () => {
  let hub: acruxcore;
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;

  const rollDie = acrux.tool(
    {
      name: 'roll_die',
      description: 'Roll an N-sided die.',
      parameters: { type: 'object', properties: { sides: { type: 'integer' } } },
    },
    async () => ({ value: 4 }),
  );

  beforeEach(() => {
    hub = new acruxcore({ apiKey: 'acx_sk_test', baseUrl: 'https://api.test/api/v1' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws TOOL_SCHEMA_ERROR naming the tool and the call that runs it', async () => {
    await expect(
      hub.gateway.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [rollDie as any],
      }),
    ).rejects.toMatchObject({ code: 'TOOL_SCHEMA_ERROR' });

    await hub.gateway
      .chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [rollDie as any],
      })
      .catch((e: Error) => {
        expect(e.message).toContain("'roll_die'");
        expect(e.message).toContain('runToolLoop');
      });
  });

  it('fails before any request is sent', async () => {
    await hub.gateway
      .chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [rollDie as any],
      })
      .catch(() => undefined);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still accepts raw OpenAI definitions', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Sunny.' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    );

    const result = await hub.gateway.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Weather.', parameters: { type: 'object', properties: {} } },
        },
      ],
    });

    expect(result.message.content).toBe('Sunny.');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
