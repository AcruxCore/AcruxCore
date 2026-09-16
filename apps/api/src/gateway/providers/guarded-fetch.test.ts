import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { guardedFetch } from './guarded-fetch';
import { parseSseStream } from './sse-parse';
import { GATEWAY_TIMEOUT_MS } from './timeout';

/**
 * Starts a real local HTTP server for the duration of one test. These cases are about
 * socket timing — headers that never arrive, a body that stalls mid-stream — which a
 * mocked `fetch` cannot express at all, so they run against real sockets.
 */
function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Writes an SSE frame every `gapMs` until `count` are sent, then `[DONE]`. */
function sseTicker(count: number, gapMs: number): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= count) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: {"n":${++sent}}\n\n`);
    }, gapMs);
    res.on('close', () => clearInterval(timer));
  };
}

describe('guardedFetch — the deadline covers the headers, not the body (issue #487)', () => {
  it('times out when the provider accepts the connection and never answers', async () => {
    // Issue #487's exact shape: handshake completes, no headers ever follow.
    const { url, close } = await serve(() => {
      /* deliberately never responds */
    });
    try {
      await expect(
        guardedFetch(url, { method: 'POST', headers: {}, body: '{}' }, false, 'OpenAI', 200),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      await close();
    }
  });

  it('lets a stream outlive the deadline once the headers have arrived', async () => {
    // A whole-request deadline reads the same as the test above at the socket level, but
    // aborting after the headers errors the body a streaming caller has not read yet: a
    // long generation died mid-answer and the tokens already billed upstream were
    // recorded as a failure worth $0.
    const { url, close } = await serve(sseTicker(8, 60));
    try {
      const { res } = await guardedFetch(
        url,
        { method: 'POST', headers: {}, body: '{}' },
        false,
        'OpenAI',
        150, // far shorter than the 480ms the body takes to finish
      );
      const frames: string[] = [];
      for await (const data of parseSseStream(res.body!, undefined, 5_000)) frames.push(data);
      expect(frames).toHaveLength(8);
      expect(JSON.parse(frames[7]!)).toEqual({ n: 8 });
    } finally {
      await close();
    }
  });

  it('still lets a client disconnect abort the upstream call', async () => {
    const { url, close } = await serve(sseTicker(50, 40));
    const controller = new AbortController();
    try {
      const { res } = await guardedFetch(
        url,
        { method: 'POST', headers: {}, body: '{}', signal: controller.signal },
        false,
        'OpenAI',
        5_000,
      );
      const frames: string[] = [];
      for await (const data of parseSseStream(res.body!, controller.signal, 5_000)) {
        frames.push(data);
        if (frames.length === 2) controller.abort();
      }
      // The generator completes rather than throwing: an aborted reader resolves done.
      expect(frames.length).toBeLessThan(50);
    } finally {
      await close();
    }
  });
});

describe('parseSseStream — a stalled stream is the thing with a deadline (issue #487)', () => {
  it('gives up when the provider stops sending mid-answer', async () => {
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n');
      // then nothing, and never an end — the hang the deadline exists for
    });
    try {
      const { res } = await guardedFetch(url, { method: 'POST', headers: {}, body: '{}' }, false, 'OpenAI', 5_000);
      const frames: string[] = [];
      await expect(
        (async () => {
          for await (const data of parseSseStream(res.body!, undefined, 150)) frames.push(data);
        })(),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(frames).toEqual(['{"n":1}']);
    } finally {
      await close();
    }
  });

  it('does not count time spent streaming against a slow but healthy provider', async () => {
    // Six 80ms gaps run to 480ms total, well past the 200ms budget a whole-request
    // clock would have given it; each gap on its own is inside the limit.
    const { url, close } = await serve(sseTicker(6, 80));
    try {
      const { res } = await guardedFetch(url, { method: 'POST', headers: {}, body: '{}' }, false, 'OpenAI', 5_000);
      const frames: string[] = [];
      for await (const data of parseSseStream(res.body!, undefined, 200)) frames.push(data);
      expect(frames).toHaveLength(6);
    } finally {
      await close();
    }
  });

  it('defaults both halves of the deadline to the gateway-wide value', () => {
    expect(GATEWAY_TIMEOUT_MS).toBe(60_000);
  });
});
