import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { lookup as realDnsLookup } from 'node:dns/promises';
import {
  assertPublicUrl,
  safeFetch,
  SsrfError,
  allowLoopbackForTests,
  resetSsrfAllowlist,
  isBlockedUrlLiteral,
  createSsrfSafeDispatcher,
} from './safe-fetch';

// Mirrors the `MAX_BYTES` cap in `safe-fetch.ts` (1 MB). Not exported from the module — kept
// as a local constant since it's test-only data, not part of the module's public surface.
const RESPONSE_SIZE_CAP = 1_000_000;

// `node:dns/promises`'s named exports are non-configurable (jest.spyOn cannot redefine
// them directly — it throws "Cannot redefine property: lookup"), so the module is
// replaced with a jest.mock factory instead. The mock delegates to the real
// implementation by default (so every other test in this file, e.g. resolving
// `localhost`, is unaffected) and only the DNS-rebinding test below overrides a single
// call via `mockResolvedValueOnce`.
jest.mock('node:dns/promises', () => {
  const actual = jest.requireActual<typeof import('node:dns/promises')>('node:dns/promises');
  return { ...actual, lookup: jest.fn(actual.lookup) };
});

describe('assertPublicUrl (SSRF guard)', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('ftp://example.com')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects loopback and private + metadata addresses', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://localhost/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://10.0.0.5/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('allows a public IP literal', async () => {
    await expect(assertPublicUrl('https://1.1.1.1/')).resolves.toBeUndefined();
  });
  it('rejects the 100.64.0.0/10 CGNAT range (covers Alibaba Cloud metadata at 100.100.100.200)', async () => {
    await expect(assertPublicUrl('http://100.100.100.200/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://100.64.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://100.127.255.255/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects fe80::/10 link-local addresses beyond the literal "fe80" prefix', async () => {
    await expect(assertPublicUrl('http://[fe90::1]/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://[febf::1]/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects IANA special-use test-net ranges', async () => {
    await expect(assertPublicUrl('http://192.0.2.1/')).rejects.toBeInstanceOf(SsrfError); // TEST-NET-1
    await expect(assertPublicUrl('http://198.51.100.1/')).rejects.toBeInstanceOf(SsrfError); // TEST-NET-2
    await expect(assertPublicUrl('http://203.0.113.1/')).rejects.toBeInstanceOf(SsrfError); // TEST-NET-3
    await expect(assertPublicUrl('http://198.18.0.1/')).rejects.toBeInstanceOf(SsrfError); // benchmarking /15
    await expect(assertPublicUrl('http://192.0.0.1/')).rejects.toBeInstanceOf(SsrfError); // IETF protocol assignments
  });
  it('handles bracketed IPv6 literal URLs via the IP-literal path, not DNS', async () => {
    // Public IPv6 literal (Cloudflare DNS) — proves the bracket-stripped hostname is recognized
    // by `net.isIP` and evaluated against the blocklist directly. If bracket-stripping were
    // missing, `net.isIP('[2606:4700:4700::1111]')` returns 0, the code would fall into the
    // DNS-lookup branch, and `dnsLookup` would reject with ENOTFOUND for this literal (it isn't
    // a resolvable hostname) — so this resolving at all is proof the IP-literal path was taken.
    await expect(assertPublicUrl('https://[2606:4700:4700::1111]/')).resolves.toBeUndefined();
  });
  it('still rejects a blocked bracketed IPv6 literal (loopback)', async () => {
    await expect(assertPublicUrl('http://[::1]/')).rejects.toBeInstanceOf(SsrfError);
  });

  // ── TC4 final review Finding 1: IPv4-mapped IPv6 addresses bypassed the guard ──
  // `new URL('http://[::ffff:127.0.0.1]/').hostname` auto-canonicalizes to the
  // hex-group form `"[::ffff:7f00:1]"` — the old `low.startsWith('::ffff:')` +
  // `slice(7)` check expected a dotted-decimal string there and fell through,
  // waving the request through. These exercise the real bug surface (the URL
  // parser's canonicalization), not `isBlockedIp` directly.
  it('rejects the IPv4-mapped-IPv6 form of the cloud-metadata address (hex-canonicalized bypass)', async () => {
    await expect(assertPublicUrl('http://[::ffff:169.254.169.254]/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects the IPv4-mapped-IPv6 form of loopback', async () => {
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects the IPv4-mapped-IPv6 form of a private (10.0.0.0/8) address', async () => {
    await expect(assertPublicUrl('http://[::ffff:10.0.0.1]/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('rejects NAT64 (RFC 6052) and IPv4-compatible (RFC 4291 §2.5.5.1) embeddings of loopback', async () => {
    await expect(assertPublicUrl('http://[64:ff9b::7f00:1]/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://[::7f00:1]/')).rejects.toBeInstanceOf(SsrfError);
  });
  it('still rejects fe80::/10 link-local beyond the literal "fe80" prefix, and no longer over-blocks fe8::1', async () => {
    // fe8::1 is NOT in fe80::/10 (it's a distinct, non-link-local address) — the old
    // `startsWith('fe8')` string-prefix check incorrectly blocked it (a previously
    // logged Minor finding). ipaddr.js's CIDR-aware range() fixes this as a side effect.
    await expect(assertPublicUrl('http://[fe8::1]/')).resolves.toBeUndefined();
    await expect(assertPublicUrl('http://[fe90::1]/')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('http://[febf::1]/')).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('safeFetch DNS-rebinding pin', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resolves DNS exactly once per call for a hostname target — the connection never re-resolves independently', async () => {
    // A hostname (not a literal IP) that we rig to resolve to the allowed loopback
    // address, so the request actually completes end-to-end while we observe DNS
    // resolution. If safeFetch (or the underlying undici connect) performed a second,
    // independent lookup for the TCP connect — the classic DNS-rebinding bypass this
    // task closes — `dnsLookup` would be called more than once for this one safeFetch
    // call. Pinning the validated IP into `connect.lookup` means the actual socket
    // connect never calls dns.lookup again, so the mock call count stays at exactly 1.
    const lookupMock = realDnsLookup as jest.Mock;
    lookupMock.mockClear();
    lookupMock.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

    const result = await safeFetch(baseUrl.replace('127.0.0.1', 'rebinding-test.invalid'), { method: 'GET' });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    // Exactly one DNS resolution for the whole call: the validation lookup. No second,
    // independent lookup happens later when undici opens the TCP connection, because
    // `safeFetch` pins the connect to the address that was already validated.
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('still reaches a real loopback target end-to-end through the test allowlist seam', async () => {
    const result = await safeFetch(`${baseUrl}/`, { method: 'GET' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
  });
});

describe('safeFetch error normalization', () => {
  let hangingServer: http.Server;
  let hangingBaseUrl: string;

  beforeAll(async () => {
    // A server that accepts the connection but never calls `res.end()` — the request just
    // hangs until something (the client-side abort timer) gives up.
    hangingServer = http.createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', resolve));
    const port = (hangingServer.address() as AddressInfo).port;
    hangingBaseUrl = `http://127.0.0.1:${port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    // The handler above never ends the response, so the socket stays open; without forcing
    // it closed, `server.close()` would hang waiting for a connection that never finishes.
    hangingServer.closeAllConnections();
    await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
  });

  it('normalizes a request timeout into SsrfError instead of a raw abort error', async () => {
    await expect(safeFetch(`${hangingBaseUrl}/`, { method: 'GET' }, 100)).rejects.toBeInstanceOf(SsrfError);
  });

  it('normalizes a DNS resolution failure into SsrfError instead of a raw ENOTFOUND error', async () => {
    // `.invalid` is the RFC 2606 reserved TLD guaranteed to never resolve in real DNS. No
    // `mockResolvedValueOnce` override here — the dns mock delegates to the real `lookup`,
    // which genuinely rejects with ENOTFOUND for this host.
    await expect(safeFetch('http://this-name-does-not-resolve.invalid/', { method: 'GET' })).rejects.toBeInstanceOf(
      SsrfError,
    );
  });
});

describe('safeFetch redirect refusal', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1/elsewhere' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses to follow a 3xx redirect and rejects with SsrfError', async () => {
    await expect(safeFetch(`${baseUrl}/`, { method: 'GET' })).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('safeFetch BOM handling', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      // A UTF-8 BOM in front of ordinary JSON — routine from IIS and .NET upstreams.
      res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ tempC: 18 }))]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('parses BOM-prefixed JSON instead of degrading it to a raw string', async () => {
    // `res.body.text()` strips the BOM per the fetch spec; the byte-counting read that
    // replaced it did not, so `JSON.parse` threw, the caller kept the raw text, and the
    // tool returned a string with a 200 — a transform reading `input.body.tempC` then
    // got `undefined` and a declared object `resultSchema` mismatched on every call.
    const result = await safeFetch(`${baseUrl}/`, { method: 'GET' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tempC: 18 });
  });
});

describe('safeFetch response size cap', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end('x'.repeat(RESPONSE_SIZE_CAP + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects a response body larger than the size cap with SsrfError', async () => {
    await expect(safeFetch(`${baseUrl}/`, { method: 'GET' })).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('safeFetch stops reading at the size cap', () => {
  let server: http.Server;
  let baseUrl: string;
  let bytesWritten = 0;

  // Streams up to 64 MB in 64 KB chunks, counting what it actually managed to
  // write. A guard that only checks the size AFTER buffering lets every byte
  // through; one that stops at the cap closes the socket long before the end.
  beforeAll(async () => {
    server = http.createServer(async (_req, res) => {
      res.setHeader('content-type', 'text/plain');
      bytesWritten = 0;
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 1024; i++) {
        if (res.writableEnded || res.destroyed) break;
        const ok = res.write(chunk);
        bytesWritten += chunk.length;
        if (!ok) await new Promise<void>((r) => res.once('drain', () => r()));
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not buffer the whole body before rejecting an oversize response', async () => {
    await expect(safeFetch(`${baseUrl}/`, { method: 'GET' })).rejects.toBeInstanceOf(SsrfError);
    // Generous ceiling: the socket and undici both hold some already-in-flight
    // data when the read stops, so the server always gets a little past the cap.
    expect(bytesWritten).toBeLessThan(8 * 1024 * 1024);
  });
});

describe('safeFetch size cap is measured in bytes', () => {
  let server: http.Server;
  let baseUrl: string;

  // 900,000 U+4E2D characters: 900,000 UTF-16 code units, but 2.7 MB on the
  // wire. A cap that compares `String.length` reads this as under 1 MB.
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(Buffer.from('\u4e2d'.repeat(900_000), 'utf8'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects a multi-byte body over the cap even though its character count is under it', async () => {
    await expect(safeFetch(`${baseUrl}/`, { method: 'GET' })).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('safeFetch reports byte counts, not character counts', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(Buffer.from('\u4e2d'.repeat(10), 'utf8')); // 10 chars, 30 bytes
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    allowLoopbackForTests();
  });

  afterAll(async () => {
    resetSsrfAllowlist();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("`bytes` counts what came off the wire", async () => {
    const res = await safeFetch(`${baseUrl}/`, { method: 'GET' });
    expect(res.bytes).toBe(30);
  });
});

describe('isBlockedUrlLiteral', () => {
  it('rejects a non-http(s) scheme', () => {
    expect(isBlockedUrlLiteral('file:///etc/passwd')).toBe(true);
  });

  it('rejects an unparseable URL', () => {
    expect(isBlockedUrlLiteral('not a url')).toBe(true);
  });

  it('rejects a loopback IP literal', () => {
    expect(isBlockedUrlLiteral('http://127.0.0.1/')).toBe(true);
  });

  it('rejects a private-range IP literal', () => {
    expect(isBlockedUrlLiteral('http://10.0.0.5/')).toBe(true);
  });

  it('rejects a link-local (cloud metadata) IP literal', () => {
    expect(isBlockedUrlLiteral('http://169.254.169.254/')).toBe(true);
  });

  it('allows a public IP literal', () => {
    expect(isBlockedUrlLiteral('http://8.8.8.8/')).toBe(false);
  });

  it('allows a hostname (deferred to the real, DNS-resolving guard)', () => {
    expect(isBlockedUrlLiteral('https://api.example.com/v1')).toBe(false);
  });
});

describe('createSsrfSafeDispatcher', () => {
  it('rejects a loopback target with SsrfError, before any dispatcher is created', async () => {
    await expect(createSsrfSafeDispatcher('http://127.0.0.1:1/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('returns a usable dispatcher for a public IP literal target', async () => {
    const { url, dispatcher } = await createSsrfSafeDispatcher('http://8.8.8.8/');
    expect(url.hostname).toBe('8.8.8.8');
    expect(dispatcher).toBeDefined();
    await dispatcher.close();
  });
});
