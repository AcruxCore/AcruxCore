import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { geminiAdapter } from './gemini.adapter';
import { ProviderError } from './adapter';
import type { NormalizedRequest } from './types';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const CANNED_GEMINI = {
  candidates: [
    { content: { parts: [{ text: 'Hi' }], role: 'model' }, finishReason: 'STOP', index: 0 },
  ],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 },
};

afterEach(() => jest.restoreAllMocks());

describe('GeminiAdapter.chatCompletion', () => {
  it('hoists system→systemInstruction, maps assistant→model, sends x-goog-api-key, puts model in the URL, and normalizes', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CANNED_GEMINI,
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Say hi.' },
        { role: 'assistant', content: 'Hi.' },
        { role: 'user', content: 'again' },
      ],
      temperature: 0.5,
      max_tokens: 40,
    };

    const res = await geminiAdapter.chatCompletion(req, { apiKey: 'g-key' });

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    );
    expect((opts.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');

    const body = JSON.parse(opts.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are terse.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Say hi.' }] },
      { role: 'model', parts: [{ text: 'Hi.' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
    expect(body.generationConfig.temperature).toBe(0.5);
    expect(body.generationConfig.maxOutputTokens).toBe(40);

    expect(res.model).toBe('gemini-1.5-flash');
    expect(res.id).toMatch(/^chatcmpl-/);
    expect(res.choices[0]?.message.content).toBe('Hi');
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 });
  });

  it('sends a tool schema as parametersJsonSchema, which accepts additionalProperties', async () => {
    // Gemini's `parameters` is an OpenAPI subset that 400s on `additionalProperties`,
    // which every zod-generated schema has. `parametersJsonSchema` takes full JSON Schema.
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CANNED_GEMINI,
    } as unknown as Response);
    const schema = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    };

    await geminiAdapter.chatCompletion(
      {
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: schema } }],
      },
      { apiKey: 'g-key' },
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.tools[0].functionDeclarations[0]).toEqual({ name: 'get_weather', parametersJsonSchema: schema });
  });

  it('maps finishReason MAX_TOKENS → length', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...CANNED_GEMINI,
        candidates: [{ ...CANNED_GEMINI.candidates[0], finishReason: 'MAX_TOKENS' }],
      }),
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const res = await geminiAdapter.chatCompletion(req, { apiKey: 'g-key' });
    expect(res.choices[0]?.finish_reason).toBe('length');
  });

  it('throws a retriable ProviderError on a 500, without leaking the raw upstream body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'super-secret-upstream-detail-should-not-leak',
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    await expect(geminiAdapter.chatCompletion(req, { apiKey: 'g-key' })).rejects.toMatchObject({
      status: 500,
      retriable: true,
    });
    const err = await geminiAdapter.chatCompletion(req, { apiKey: 'g-key' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).not.toContain('super-secret-upstream-detail-should-not-leak');
  });

  it('rejects a custom base_url pointing at a blocked (loopback) address before making any request', async () => {
    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    await expect(
      geminiAdapter.chatCompletion(req, { apiKey: 'g-key', baseUrl: 'http://127.0.0.1:1/v1beta' }),
    ).rejects.toMatchObject({ status: 502, retriable: false });
  });

  it('translates response_format into responseMimeType and responseJsonSchema, which accepts additionalProperties', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CANNED_GEMINI,
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          // OpenAI strict mode and every zod schema carry additionalProperties: false, which
          // Gemini's OpenAPI-subset `responseSchema` rejects with a 400.
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
        },
      },
    };
    await geminiAdapter.chatCompletion(req, { apiKey: 'g-key' });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeUndefined();
    expect(body.generationConfig.responseJsonSchema).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      additionalProperties: false,
    });
  });

  it('sets responseMimeType only, no schema, for json_object', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CANNED_GEMINI,
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    };
    await geminiAdapter.chatCompletion(req, { apiKey: 'g-key' });

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeUndefined();
    expect(body.generationConfig.responseJsonSchema).toBeUndefined();
  });

  describe('dispatcher cleanup on a real connection failure (custom base_url)', () => {
    beforeAll(() => allowLoopbackForTests());
    afterAll(() => resetSsrfAllowlist());

    it('closes the SSRF-safe dispatcher when the connection attempt fails after the dispatcher was already created', async () => {
      // Loopback is allow-listed for this test, so the SSRF DNS/IP check passes and a real
      // dispatcher gets created — but nothing listens on this port, so the actual connection
      // attempt (undiciRequest) then fails with ECONNREFUSED. Bug: guardedFetch used to throw
      // before returning `{ res, dispatcher }`, so the caller's `dispatcher` variable was never
      // assigned and its `finally { dispatcher?.close() }` never ran, leaking the Agent.
      const closeSpy = jest.spyOn(Agent.prototype, 'close');
      const req: NormalizedRequest = {
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      };

      const err = await geminiAdapter
        .chatCompletion(req, { apiKey: 'g-key', baseUrl: 'http://127.0.0.1:1/v1beta' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(502);
      expect((err as ProviderError).retriable).toBe(true);
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  describe('with a real local server standing in for a custom base_url', () => {
    let server: http.Server;
    let baseUrl: string;
    let receivedApiKey: string | undefined;

    beforeAll(async () => {
      server = http.createServer((httpReq, res) => {
        receivedApiKey = httpReq.headers['x-goog-api-key'] as string | undefined;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(CANNED_GEMINI));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}/v1beta`;
      allowLoopbackForTests();
    });

    afterAll(async () => {
      resetSsrfAllowlist();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('uses the provided base_url, routed through the SSRF-safe dispatcher', async () => {
      const req: NormalizedRequest = {
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      };
      const res = await geminiAdapter.chatCompletion(req, { apiKey: 'g-key', baseUrl });

      expect(receivedApiKey).toBe('g-key');
      expect(res.choices[0]?.message.content).toBe('Hi');
    });
  });
});

describe('GeminiAdapter.streamChatCompletion', () => {
  it('numbers parallel tool calls across frames, so calls in separate frames stay separate', async () => {
    // Gemini 3 can send each parallel call in its own SSE frame. Numbering per frame gave
    // both index 0, and the gateway's index-keyed fold merged them into one broken call.
    const frames = [
      { candidates: [{ content: { role: 'model', parts: [
        { functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'SIG1' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [
        { functionCall: { id: 'call_2', name: 'get_weather', args: { city: 'Rome' } } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } },
    ];
    const raw = new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join(''));
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }), { status: 200 }),
    );
    const req: NormalizedRequest = { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'Paris and Rome?' }] };
    const seen: { index?: number; id: string }[] = [];
    for await (const chunk of geminiAdapter.streamChatCompletion(req, { apiKey: 'g-key' })) {
      for (const tc of chunk.tool_calls ?? []) seen.push({ index: tc.index, id: tc.id });
    }
    expect(seen).toEqual([{ index: 0, id: 'call_1' }, { index: 1, id: 'call_2' }]);
  });

  it('rejects a custom base_url pointing at a blocked (loopback) address before making any request', async () => {
    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const iterator = geminiAdapter
      .streamChatCompletion(req, { apiKey: 'g-key', baseUrl: 'http://127.0.0.1:1/v1beta' })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ status: 502, retriable: false });
  });

  it('throws a non-leaking ProviderError on a 500 before the first chunk', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
      text: async () => 'super-secret-stream-detail-should-not-leak',
    } as unknown as Response);

    const req: NormalizedRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const iterator = geminiAdapter.streamChatCompletion(req, { apiKey: 'g-key' })[Symbol.asyncIterator]();
    const err = await iterator.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).not.toContain('super-secret-stream-detail-should-not-leak');
  });

  describe('a real network failure (not an SSRF block) during streaming', () => {
    beforeAll(() => allowLoopbackForTests());
    afterAll(() => resetSsrfAllowlist());

    it('normalizes the connection failure into a retriable ProviderError instead of a raw exception', async () => {
      // Loopback is allow-listed here, so the SSRF check passes and the request actually
      // attempts to connect — to a port nothing listens on, so it fails with ECONNREFUSED.
      // Bug: streamChatCompletion had no try/catch around its guardedFetch call, so this
      // propagated as a raw, un-normalized exception instead of a ProviderError.
      const req: NormalizedRequest = {
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      };
      const iterator = geminiAdapter
        .streamChatCompletion(req, { apiKey: 'g-key', baseUrl: 'http://127.0.0.1:1/v1beta' })
        [Symbol.asyncIterator]();
      const err = await iterator.next().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(502);
      expect((err as ProviderError).retriable).toBe(true);
    });
  });
});
