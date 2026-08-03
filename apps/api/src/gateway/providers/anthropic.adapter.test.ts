import { anthropicAdapter } from './anthropic.adapter';
import { ProviderError } from './adapter';
import type { NormalizedRequest } from './types';

const CANNED_ANTHROPIC = {
  id: 'msg_123',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet-latest',
  content: [{ type: 'text', text: 'Hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 15, output_tokens: 2 },
};

afterEach(() => jest.restoreAllMocks());

describe('AnthropicAdapter.chatCompletion', () => {
  it('maps system messages to top-level system, defaults max_tokens, and sends x-api-key headers', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CANNED_ANTHROPIC,
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Say hi.' },
      ],
      // max_tokens intentionally omitted → adapter must default it
    };

    const res = await anthropicAdapter.chatCompletion(req, { apiKey: 'anthropic-key' });

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(opts.body as string);
    expect(body.system).toBe('You are terse.'); // system pulled out
    expect(body.messages).toEqual([{ role: 'user', content: 'Say hi.' }]); // system removed from messages
    expect(body.max_tokens).toBe(1024); // defaulted

    // Response normalization
    expect(res.choices[0]?.message.content).toBe('Hi');
    expect(res.choices[0]?.finish_reason).toBe('stop'); // end_turn → stop
    expect(res.usage).toEqual({ prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 });
  });

  it('maps stop_reason max_tokens → length and honors an explicit max_tokens', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...CANNED_ANTHROPIC, stop_reason: 'max_tokens' }),
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 256,
    };

    const res = await anthropicAdapter.chatCompletion(req, { apiKey: 'anthropic-key' });
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string).max_tokens).toBe(256);
    expect(res.choices[0]?.finish_reason).toBe('length');
  });

  it('maps tool_use response blocks to tool_calls with JSON-stringified arguments', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...CANNED_ANTHROPIC,
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
        stop_reason: 'tool_use',
      }),
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    };

    const res = await anthropicAdapter.chatCompletion(req, { apiKey: 'anthropic-key' });
    expect(res.choices[0]?.message.tool_calls).toEqual([
      { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
  });

  describe('tool_choice translation', () => {
    async function sendWithToolChoice(toolChoice: NormalizedRequest['tool_choice']): Promise<Record<string, unknown>> {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => CANNED_ANTHROPIC,
      } as unknown as Response);
      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        tool_choice: toolChoice,
      };
      await anthropicAdapter.chatCompletion(req, { apiKey: 'anthropic-key' });
      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      return JSON.parse(opts.body as string) as Record<string, unknown>;
    }

    it("'auto' -> { type: 'auto' }", async () => {
      const body = await sendWithToolChoice('auto');
      expect(body.tool_choice).toEqual({ type: 'auto' });
      expect(body.tools).toHaveLength(1);
    });

    it("'required' -> { type: 'any' }", async () => {
      const body = await sendWithToolChoice('required');
      expect(body.tool_choice).toEqual({ type: 'any' });
    });

    it("{ type: 'function', function: { name } } -> { type: 'tool', name }", async () => {
      const body = await sendWithToolChoice({ type: 'function', function: { name: 'get_weather' } });
      expect(body.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    });

    it("'none' -> omits both tools and tool_choice (Anthropic has no visible-but-uncallable mode)", async () => {
      const body = await sendWithToolChoice('none');
      expect(body.tool_choice).toBeUndefined();
      expect(body.tools).toBeUndefined();
    });
  });

  describe('response_format translation', () => {
    it('translates response_format into a forced tool call', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ...CANNED_ANTHROPIC,
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'answer', input: { ok: true } }],
          stop_reason: 'tool_use',
        }),
      } as unknown as Response);

      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
        },
      };

      await anthropicAdapter.chatCompletion(req, { apiKey: 'anthropic-key' });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.tools).toEqual([
        {
          name: 'answer',
          description: expect.any(String),
          input_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      ]);
      expect(body.tool_choice).toEqual({ type: 'tool', name: 'answer' });
    });

    it('translates a json_object request into a generic forced tool call', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ...CANNED_ANTHROPIC,
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'structured_output', input: { ok: true } }],
          stop_reason: 'tool_use',
        }),
      } as unknown as Response);

      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      };

      await anthropicAdapter.chatCompletion(req, { apiKey: 'anthropic-key' });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.tools).toEqual([
        { name: 'structured_output', description: expect.any(String), input_schema: { type: 'object' } },
      ]);
      expect(body.tool_choice).toEqual({ type: 'tool', name: 'structured_output' });
    });

    it('parses the forced tool call back into JSON message content', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ...CANNED_ANTHROPIC,
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'answer', input: { ok: true } }],
          stop_reason: 'tool_use',
        }),
      } as unknown as Response);

      const req: NormalizedRequest = {
        model: 'claude-3-5-sonnet-latest',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
      };

      const res = await anthropicAdapter.chatCompletion(req, { apiKey: 'anthropic-key' });
      expect(JSON.parse(res.choices[0]?.message.content as string)).toEqual({ ok: true });
      expect(res.choices[0]?.finish_reason).toBe('stop');
      expect(res.choices[0]?.message.tool_calls).toBeUndefined();
    });
  });

  it('throws a retriable ProviderError on a 500, without leaking the raw upstream body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'super-secret-upstream-detail-should-not-leak',
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
    };
    await expect(anthropicAdapter.chatCompletion(req, { apiKey: 'a-key' })).rejects.toMatchObject({
      status: 500,
      retriable: true,
    });
    const err = await anthropicAdapter.chatCompletion(req, { apiKey: 'a-key' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).not.toContain('super-secret-upstream-detail-should-not-leak');
  });
});

describe('AnthropicAdapter.streamChatCompletion', () => {
  it('throws a non-leaking ProviderError on a 500 before the first chunk', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
      text: async () => 'super-secret-stream-detail-should-not-leak',
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const iterator = anthropicAdapter.streamChatCompletion(req, { apiKey: 'a-key' })[Symbol.asyncIterator]();
    const err = await iterator.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).not.toContain('super-secret-stream-detail-should-not-leak');
  });
});
