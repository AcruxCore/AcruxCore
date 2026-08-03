import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { openaiAdapter, openaiCompatibleAdapter } from './openai.adapter';
import { ProviderError } from './adapter';
import type { NormalizedRequest } from './types';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

const CANNED_OPENAI = {
  id: 'chatcmpl-abc',
  object: 'chat.completion',
  created: 1751536800,
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
};

const req: NormalizedRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in one word.' }],
  temperature: 0.7,
  max_tokens: 50,
};

afterEach(() => jest.restoreAllMocks());

describe('OpenAiAdapter.chatCompletion', () => {
  it('POSTs to the default base URL with a Bearer key and normalizes the response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CANNED_OPENAI,
    } as unknown as Response);

    const res = await openaiAdapter.chatCompletion(req, { apiKey: 'sk-test' });

    // Request assertions
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual(req.messages);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(50);

    // Response assertions
    expect(res.id).toBe('chatcmpl-abc');
    expect(res.choices[0]?.message.content).toBe('Hi');
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 });
  });

  it('passes response_format through untranslated', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => CANNED_OPENAI,
    } as unknown as Response);
    const reqWithFormat: NormalizedRequest = {
      ...req,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
    };
    await openaiAdapter.chatCompletion(reqWithFormat, { apiKey: 'sk-test' });
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } });
  });

  describe('with a real local server standing in for a custom base_url', () => {
    let server: http.Server;
    let baseUrl: string;
    let receivedAuth: string | undefined;

    beforeAll(async () => {
      server = http.createServer((httpReq, res) => {
        receivedAuth = httpReq.headers['authorization'];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(CANNED_OPENAI));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}/v1`;
      allowLoopbackForTests();
    });

    afterAll(async () => {
      resetSsrfAllowlist();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('openai_compatible uses the provided base_url, routed through the SSRF-safe dispatcher', async () => {
      const res = await openaiCompatibleAdapter.chatCompletion(req, {
        apiKey: 'sk-groq',
        baseUrl,
      });

      expect(receivedAuth).toBe('Bearer sk-groq');
      expect(res.id).toBe('chatcmpl-abc');
    });
  });

  it('rejects a custom base_url pointing at a blocked (loopback) address before making any request', async () => {
    await expect(
      openaiCompatibleAdapter.chatCompletion(req, { apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:1/v1' }),
    ).rejects.toMatchObject({ status: 502, retriable: false });
  });

  it('throws a retriable ProviderError on a 500, without leaking the raw upstream body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'super-secret-upstream-detail-should-not-leak',
    } as unknown as Response);

    await expect(openaiAdapter.chatCompletion(req, { apiKey: 'sk-test' })).rejects.toMatchObject({
      status: 500,
      retriable: true,
    });
    const err = await openaiAdapter.chatCompletion(req, { apiKey: 'sk-test' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).not.toContain('super-secret-upstream-detail-should-not-leak');
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

      const err = await openaiCompatibleAdapter
        .chatCompletion(req, { apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:1/v1' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(502);
      expect((err as ProviderError).retriable).toBe(true);
      expect(closeSpy).toHaveBeenCalled();
    });
  });
});

describe('OpenAiAdapter.streamChatCompletion', () => {
  it('rejects a custom base_url pointing at a blocked (loopback) address before making any request', async () => {
    const iterator = openaiCompatibleAdapter
      .streamChatCompletion(req, { apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:1/v1' })
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

    const iterator = openaiAdapter.streamChatCompletion(req, { apiKey: 'sk-test' })[Symbol.asyncIterator]();
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
      const iterator = openaiCompatibleAdapter
        .streamChatCompletion(req, { apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:1/v1' })
        [Symbol.asyncIterator]();
      const err = await iterator.next().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(502);
      expect((err as ProviderError).retriable).toBe(true);
    });
  });
});
