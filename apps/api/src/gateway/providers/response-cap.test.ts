import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openaiCompatibleAdapter } from './openai.adapter';
import { ProviderError } from './adapter';
import { MAX_PROVIDER_RESPONSE_BYTES } from './response-cap';
import type { NormalizedRequest } from './types';
import { allowLoopbackForTests, resetSsrfAllowlist } from '../../tools/execute/safe-fetch';

/**
 * How much of a provider's answer the gateway is willing to hold in memory (#509).
 *
 * `openai_compatible` requires a team-supplied `base_url`, which is the BYOK and
 * self-hosted-model path — the destination is chosen by the caller, exactly like
 * a tool executor's URL. #496 capped the tool path at 1 MB while this one read
 * whatever came back, so a broken or hostile endpoint could make the gateway
 * buffer the entire body before anything looked at it.
 *
 * The server below streams a real body over a real socket rather than mocking
 * `res.json()`, because the thing being measured is the buffering, and a mock
 * that resolves an object never buffers anything.
 */
const req: NormalizedRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in one word.' }],
  max_tokens: 50,
};

/** An OpenAI-shaped completion whose assistant content is `contentBytes` of text. */
function hugeCompletion(contentBytes: number): { head: string; filler: Buffer; tail: string } {
  const head =
    '{"id":"chatcmpl-huge","object":"chat.completion","created":1751536800,' +
    '"model":"gpt-4o-mini","choices":[{"index":0,"message":{"role":"assistant","content":"';
  const tail =
    '"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}';
  return { head, filler: Buffer.alloc(contentBytes, 'a'), tail };
}

describe('a provider response larger than the gateway will buffer', () => {
  let server: http.Server;
  let baseUrl: string;
  /** Bytes the server actually managed to write before the client went away. */
  let written = 0;
  let contentBytes = 0;

  beforeAll(async () => {
    /** Writes one chunk, waiting for `drain` so the socket's own buffer is not the test. */
    const write = (res: http.ServerResponse, buf: Buffer | string): Promise<void> =>
      new Promise((resolve) => {
        written += Buffer.byteLength(buf);
        if (res.write(buf)) resolve();
        else res.once('drain', resolve);
      });

    server = http.createServer((httpReq, res) => {
      httpReq.resume();
      httpReq.on('end', () => {
        void (async () => {
          const { head, filler, tail } = hugeCompletion(contentBytes);
          res.setHeader('content-type', 'application/json');
          await write(res, head);
          // 64 KB at a time, honouring backpressure, so `written` measures what the
          // client was willing to take rather than what this process queued. Without
          // the wait the whole body lands in the socket buffer whatever the client
          // does, and the assertion below would be about Node, not about the cap.
          const CHUNK = 64 * 1024;
          for (let off = 0; off < filler.length && !res.destroyed; off += CHUNK) {
            await write(res, filler.subarray(off, off + CHUNK));
          }
          if (!res.destroyed) res.end(tail);
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts a large but legitimate answer — the control for the case below', async () => {
    // 1 MB of content is far more than any real completion and well under the cap,
    // so a guard that simply refused everything would fail here.
    contentBytes = 1024 * 1024;
    written = 0;

    const res = await openaiCompatibleAdapter.chatCompletion(req, { apiKey: 'sk-t', baseUrl });

    expect(typeof res.choices[0].message.content).toBe('string');
    expect((res.choices[0].message.content as string).length).toBe(contentBytes);
  });

  it('refuses one that would not fit, and says so as a provider error', async () => {
    contentBytes = MAX_PROVIDER_RESPONSE_BYTES + 1024 * 1024;
    written = 0;

    await expect(
      openaiCompatibleAdapter.chatCompletion(req, { apiKey: 'sk-t', baseUrl }),
    ).rejects.toThrow(ProviderError);
  });

  it('stops reading at the cap instead of draining the whole body first', async () => {
    // The point of the cap is that the bytes are never all held at once. If the
    // guard only measured the body after buffering it, the server would have
    // written every byte before anything complained.
    contentBytes = MAX_PROVIDER_RESPONSE_BYTES * 2;
    written = 0;

    await expect(
      openaiCompatibleAdapter.chatCompletion(req, { apiKey: 'sk-t', baseUrl }),
    ).rejects.toThrow(ProviderError);

    // Some slack for the socket buffers already in flight when we hung up.
    expect(written).toBeLessThan(contentBytes);
  }, 30_000);
});
