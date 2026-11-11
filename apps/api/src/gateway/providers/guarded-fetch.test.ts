import http from 'node:http';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { guardedFetch } from './guarded-fetch';
import { parseSseStream, SSE_DRAIN_TIMEOUT_MS } from './sse-parse';
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
    // writeHead only buffers the headers; without a flush they ride out with the first
    // frame, and the headers deadline under test races the ticker instead of the socket.
    res.flushHeaders();
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
    // The margins are wide on purpose: a busy CI runner can take a few hundred ms just to
    // open the first fetch, and a 150ms deadline failed there with headers still on the way.
    const { url, close } = await serve(sseTicker(8, 250));
    try {
      const { res } = await guardedFetch(
        url,
        { method: 'POST', headers: {}, body: '{}' },
        false,
        'OpenAI',
        1_000, // half the 2s the body takes to finish
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

/**
 * A raw TCP HTTP/1.1 server. Plain TCP on purpose: Node's HTTP server sends
 * `Keep-Alive: timeout=N`, which undici honours over its own default and which would hide
 * the connection-reuse behaviour these tests check. OpenAI, Anthropic and Gemini send no
 * such header, and neither does this server.
 *
 * @param respond - Writes the reply to request number `index` (0-based, across all sockets).
 * @returns The URL, the client port of each request in arrival order, when each socket
 *   closed (keyed by client port), and a `close` that tears everything down. undici may open
 *   a spare socket that never carries a request, so look sockets up by a request's port.
 */
async function rawTcpServer(respond: (socket: Socket, index: number) => void): Promise<{
  url: string;
  ports: number[];
  closedAt: Map<number, number>;
  close: () => Promise<void>;
}> {
  const ports: number[] = [];
  const closedAt = new Map<number, number>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    // A client that cancels mid-body resets the socket; that is expected, not a test failure.
    socket.on('error', () => undefined);
    const port = socket.remotePort ?? -1;
    socket.on('close', () => closedAt.set(port, Date.now()));
    let pending = '';
    socket.on('data', (chunk) => {
      // Accumulate: a request's header block may arrive split across TCP chunks.
      pending += chunk.toString('latin1');
      let end: number;
      while ((end = pending.indexOf('\r\n\r\n')) !== -1) {
        const head = pending.slice(0, end);
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        if (pending.length < end + 4 + length) break;
        pending = pending.slice(end + 4 + length);
        ports.push(socket.remotePort ?? -1);
        respond(socket, ports.length - 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    ports,
    closedAt,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const PLAIN_OK = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok';

describe('guardedFetch — idle provider connections stay open for reuse (PR #814)', () => {
  it('sends a call after more than 4 idle seconds on the same connection', async () => {
    const srv = await rawTcpServer((socket) => socket.write(PLAIN_OK));
    const call = async (): Promise<void> => {
      const { res } = await guardedFetch(srv.url, { method: 'POST', headers: {}, body: '{}' }, false, 'OpenAI');
      await res.text();
    };
    try {
      await call();
      // Node's built-in fetch closes an idle connection after 4 seconds.
      await new Promise((resolve) => setTimeout(resolve, 4_500));
      await call();
      expect(srv.ports).toHaveLength(2);
      expect(srv.ports[1]).toBe(srv.ports[0]);
    } finally {
      await srv.close();
    }
  }, 15_000);
});

/**
 * A server that answers request 1 with a chunked SSE stream and every later request with a
 * plain `ok`.
 *
 * @param terminator - When to send the chunked body's `0\r\n\r\n` after `[DONE]`: a delay in
 *   ms, or `'never'` for a provider that leaves the body open.
 */
function sseThenPlainServer(terminator: number | 'never'): ReturnType<typeof rawTcpServer> {
  const chunked = (s: string): string => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`;
  return rawTcpServer((socket, index) => {
    if (index > 0) {
      socket.write(PLAIN_OK);
      return;
    }
    socket.write(
      'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n' +
        chunked('data: {"n":1}\n\n') +
        chunked('data: {"n":2}\n\n') +
        chunked('data: [DONE]\n\n'),
    );
    // A real provider's terminator often lands in a later TCP packet than [DONE].
    if (terminator !== 'never') {
      setTimeout(() => {
        if (!socket.destroyed) socket.write('0\r\n\r\n');
      }, terminator);
    }
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Streams one call to `url` and returns its frames and how long the stream took to end. */
async function streamOnce(
  url: string,
  options?: Parameters<typeof parseSseStream>[3],
  idleTimeoutMs?: number,
): Promise<{ frames: string[]; tookMs: number }> {
  const { res } = await guardedFetch(url, { method: 'POST', headers: {}, body: '{}' }, false, 'OpenAI');
  const started = Date.now();
  const frames: string[] = [];
  for await (const data of parseSseStream(res.body!, undefined, idleTimeoutMs, options)) frames.push(data);
  return { frames, tookMs: Date.now() - started };
}

/** Sends a plain call to `url` and returns its body. */
async function plainCall(url: string): Promise<string> {
  const { res } = await guardedFetch(url, { method: 'POST', headers: {}, body: '{}' }, false, 'OpenAI');
  return res.text();
}

describe('parseSseStream — a stream that ends at [DONE] keeps its connection (issue #816)', () => {
  it('reuses the connection for the next call after a streamed call', async () => {
    const srv = await sseThenPlainServer(50);
    try {
      const { frames } = await streamOnce(srv.url);
      expect(frames).toEqual(['{"n":1}', '{"n":2}']);

      // undici puts a finished socket back in its pool a moment after the body ends. A real
      // next call comes later than this; a cancelled socket stays lost however long we wait.
      await sleep(200);
      expect(await plainCall(srv.url)).toBe('ok');
      expect(srv.ports).toHaveLength(2);
      expect(srv.ports[1]).toBe(srv.ports[0]);
    } finally {
      await srv.close();
    }
  });

  it('ends the stream at [DONE] without waiting for the body to end', async () => {
    // The gateway records the call and sends the client its own [DONE] only once the stream
    // ends, so any wait here would be added to every streamed call.
    const srv = await sseThenPlainServer('never');
    try {
      const { frames, tookMs } = await streamOnce(srv.url);
      expect(frames).toEqual(['{"n":1}', '{"n":2}']);
      expect(tookMs).toBeLessThan(200);
    } finally {
      await srv.close();
    }
  });

  it('still reuses the connection when the body ends after the stream has returned', async () => {
    const srv = await sseThenPlainServer(300);
    try {
      const { tookMs } = await streamOnce(srv.url);
      expect(tookMs).toBeLessThan(200);
      await sleep(500);
      expect(await plainCall(srv.url)).toBe('ok');
      expect(srv.ports[1]).toBe(srv.ports[0]);
    } finally {
      await srv.close();
    }
  });

  it('drops the connection after SSE_DRAIN_TIMEOUT_MS when the body never ends', async () => {
    const srv = await sseThenPlainServer('never');
    try {
      const started = Date.now();
      await streamOnce(srv.url);
      await sleep(SSE_DRAIN_TIMEOUT_MS + 500);
      const closedAfter = srv.closedAt.get(srv.ports[0])! - started;
      expect(closedAfter).toBeGreaterThanOrEqual(SSE_DRAIN_TIMEOUT_MS - 50);
      expect(closedAfter).toBeLessThan(SSE_DRAIN_TIMEOUT_MS + 400);
    } finally {
      await srv.close();
    }
  }, 10_000);

  it('drains for no longer than the idle deadline when that is shorter', async () => {
    const srv = await sseThenPlainServer('never');
    try {
      const started = Date.now();
      await streamOnce(srv.url, undefined, 150);
      await sleep(600);
      expect(srv.closedAt.get(srv.ports[0])! - started).toBeLessThan(500);
    } finally {
      await srv.close();
    }
  });

  it('cancels at once instead of draining when the caller will close the connection anyway', async () => {
    // A custom base URL gets its own dispatcher, closed after the call, so its socket can
    // never be reused and a drain would only delay that close.
    const srv = await sseThenPlainServer(300);
    try {
      const started = Date.now();
      await streamOnce(srv.url, { drainAfterDone: false });
      await sleep(100);
      expect(srv.closedAt.get(srv.ports[0])! - started).toBeLessThan(200);
    } finally {
      await srv.close();
    }
  });
});
