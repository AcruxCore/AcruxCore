import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import net from 'node:net';
import { Agent, request as undiciRequest, type Dispatcher } from 'undici';
import ipaddr from 'ipaddr.js';

/** Thrown when a URL fails the SSRF guard (bad scheme, private/loopback/metadata IP, oversize, redirect). */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Test-only allowlist of otherwise-blocked IPs. Empty in production — nothing in the
 * app ever adds to it. Integration tests that must reach a real loopback server call
 * `allowLoopbackForTests()` in `beforeAll` and `resetSsrfAllowlist()` in `afterAll`.
 * There is deliberately NO env-var or NODE_ENV bypass: the guard has no runtime hole
 * unless test code explicitly opens one in-process.
 */
const testAllowedIps = new Set<string>();

/** TEST ONLY: permit loopback (127.0.0.1 / ::1) through the SSRF guard. Never called in app code. */
export function allowLoopbackForTests(): void {
  testAllowedIps.add('127.0.0.1');
  testAllowedIps.add('::1');
}

/** TEST ONLY: clear the SSRF allowlist, restoring the full guard. */
export function resetSsrfAllowlist(): void {
  testAllowedIps.clear();
}

const MAX_BYTES = 1_000_000; // 1 MB response cap
const TIMEOUT_MS = 10_000;

/**
 * Classifies a plain `ipaddr.IPv4` address using the library's own CIDR-aware
 * `range()` (loopback/private/linkLocal/carrierGradeNat/reserved/etc.), allow-listing
 * only `'unicast'` (the "ordinary public address" range) rather than enumerating every
 * bad range by name — enumeration is exactly the class of mistake (missed ranges) that
 * a prior review already had to correct twice on this guard.
 *
 * One gap in the installed `ipaddr.js` (1.9.1) is patched explicitly: its built-in
 * IPv4 `SpecialRanges` table has no entry for 198.18.0.0/15 (RFC 2544 benchmarking),
 * so that range classifies as the default `'unicast'` unless checked separately here.
 */
function isBlockedIPv4(addr: ipaddr.IPv4): boolean {
  if (addr.range() !== 'unicast') return true;
  const [a, b] = addr.toByteArray();
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking) — missing from ipaddr.js's table
  return false;
}

/**
 * True for IPv4/IPv6 ranges we must never reach from server-side fetch.
 *
 * Delegates classification to `ipaddr.js` instead of hand-rolled octet/string-prefix
 * checks, which is what closes the IPv4-mapped-IPv6 SSRF bypass: `ipaddr.process()`
 * normalizes the standard IPv4-mapped form (`::ffff:127.0.0.1`, and its equivalent
 * hex-group form `::ffff:7f00:1` that `new URL(...)` auto-canonicalizes to) down to a
 * plain IPv4 address *before* classification, so the embedded address is what actually
 * gets checked rather than an opaque IPv6 string a prefix check could miss.
 *
 * Other IPv6 forms that embed an IPv4 address in a way `ipaddr.process()` does not
 * normalize — NAT64 (`64:ff9b::/96`, RFC 6052), 6to4, Teredo, RFC 6145 translation —
 * are covered because `ipaddr.js` classifies each as its own named (non-`'unicast'`)
 * range, so the allow-unicast-only policy below blocks them outright. The one form
 * `ipaddr.js` classifies as plain `'unicast'` despite embedding an IPv4 address is the
 * deprecated "IPv4-compatible" form (`::a.b.c.d`, RFC 4291 §2.5.5.1: top 96 bits all
 * zero) — that one is unwrapped manually via `extractEmbeddedIPv4` and the embedded
 * address is classified in its place.
 */
function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return true; // unparseable input must fail closed
  }

  if (addr instanceof ipaddr.IPv4) return isBlockedIPv4(addr);

  if (addr.range() !== 'unicast') return true;

  const embedded = extractEmbeddedIPv4(addr);
  if (embedded) return isBlockedIPv4(embedded);

  return false;
}

/**
 * Unwraps the deprecated "IPv4-compatible" IPv6 form (`::a.b.c.d` — RFC 4291 §2.5.5.1,
 * top 96 bits all zero, distinct from the `::ffff:a.b.c.d` IPv4-*mapped* form `ipaddr.js`
 * already normalizes via `process()`) into the `ipaddr.IPv4` address it embeds.
 *
 * @returns The embedded IPv4 address, or `null` if `addr`'s top 96 bits are not all zero.
 */
function extractEmbeddedIPv4(addr: ipaddr.IPv6): ipaddr.IPv4 | null {
  const parts = addr.parts;
  if (!parts.slice(0, 6).every((p) => p === 0)) return null;
  const a = (parts[6]! >> 8) & 0xff;
  const b = parts[6]! & 0xff;
  const c = (parts[7]! >> 8) & 0xff;
  const d = parts[7]! & 0xff;
  return new ipaddr.IPv4([a, b, c, d]);
}

/** A DNS-resolved (or literal) candidate address paired with its IP family. */
interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** The outcome of validating a URL: the parsed URL plus exactly one address to pin to. */
interface ValidatedTarget {
  url: URL;
  pinnedIp: string;
  pinnedFamily: 4 | 6;
}

/**
 * Resolves `rawUrl`'s host — once — to its candidate IP addresses (a single-element list
 * for a literal-IP host, or every A/AAAA answer for a hostname via `node:dns/promises`),
 * validates that none of them is private/loopback/link-local/metadata, and returns the
 * parsed URL together with one validated address to pin the connection to.
 *
 * This single-resolution-then-pin shape is what closes a DNS-rebinding TOCTOU gap: if
 * validation and the eventual TCP connect each resolved DNS independently, an
 * attacker-controlled hostname could answer with a public IP for the first lookup and a
 * private/metadata IP for the second (moments later), walking straight through the guard.
 * By resolving exactly once here and having the caller pin the actual socket to the
 * address returned below (see `safeFetch`'s `connect.lookup` override), no second,
 * independent DNS lookup ever happens for the request this validation covers.
 *
 * @throws {SsrfError} On a bad scheme, an unresolvable host, or any blocked address.
 */
async function resolveAndValidateTarget(rawUrl: string): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('Invalid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http(s) URLs are allowed.');
  }
  // `new URL('http://[::1]/').hostname` returns the bracketed literal `"[::1]"` — `net.isIP`
  // does not recognize brackets, so an IPv6 literal URL would otherwise fall through to the
  // DNS-lookup branch below and fail with ENOTFOUND (no literal is registered in DNS). Strip
  // the brackets only when both are present so plain hostnames are untouched.
  const host = url.hostname;
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  let candidates: ResolvedAddress[];
  if (net.isIP(bareHost)) {
    candidates = [{ address: bareHost, family: net.isIPv6(bareHost) ? 6 : 4 }];
  } else {
    try {
      const results = await dnsLookup(bareHost, { all: true });
      candidates = results.map((r: LookupAddress) => ({
        address: r.address,
        family: r.family === 6 ? 6 : 4,
      }));
    } catch {
      throw new SsrfError('Host did not resolve.');
    }
  }
  if (candidates.length === 0) throw new SsrfError('Host did not resolve.');
  for (const { address } of candidates) {
    if (testAllowedIps.has(address)) continue; // test-only seam; empty set in production
    if (isBlockedIp(address)) throw new SsrfError(`Blocked address: ${address}`);
  }
  const [chosen] = candidates;
  return { url, pinnedIp: chosen.address, pinnedFamily: chosen.family };
}

/**
 * Validates a URL is safe to fetch server-side: http(s) only, and every DNS-resolved
 * address is a public unicast IP. Resolves DNS itself so a hostname cannot smuggle a
 * private target.
 *
 * @throws {SsrfError} On a bad scheme or any private/loopback/link-local/metadata IP.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  await resolveAndValidateTarget(rawUrl);
}

/**
 * Synchronous, literal-IP-only SSRF pre-check for validation contexts that can't await a
 * real DNS lookup (e.g. a Zod `.refine()` invoked via the sync `parse`/`safeParse`). Catches
 * the common, obvious case — a user pastes a raw private/loopback/link-local IP as a
 * `base_url` — as a fast, friendly validation error at connection-create time.
 *
 * This is NOT the real security boundary: a hostname (not a literal IP) always returns
 * `false` here, since resolving it would require DNS. The actual boundary is
 * {@link createSsrfSafeDispatcher} (or {@link safeFetch}), applied at the moment of the real
 * request, which resolves DNS once and pins the connection to the validated address —
 * closing the DNS-rebinding gap a schema-time check can never close on its own.
 *
 * @param rawUrl - The URL to check.
 * @returns True if the URL has a bad scheme or its hostname is a literal blocked IP.
 */
export function isBlockedUrlLiteral(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  const host = url.hostname;
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!net.isIP(bareHost)) return false; // a hostname — deferred to the real, DNS-resolving guard
  return isBlockedIp(bareHost);
}

/**
 * Resolves and validates a URL exactly like {@link safeFetch}'s internal guard, then hands
 * back an undici `Agent` pinned to the validated address, for callers that need the raw
 * WHATWG `fetch()` response (e.g. a streaming body) rather than `safeFetch`'s buffered
 * JSON/text result. The caller is responsible for passing `dispatcher` into `fetch()` and
 * calling `dispatcher.close()` once done with the response (including once a streamed body
 * is fully consumed) — the pin only lasts for the lifetime of this one dispatcher.
 *
 * @param rawUrl - The absolute http(s) URL the caller intends to fetch.
 * @returns The parsed URL and a pinned `Agent` to pass as `fetch`'s `dispatcher` option.
 * @throws {SsrfError} On a bad scheme, an unresolvable host, or any blocked address.
 */
export async function createSsrfSafeDispatcher(rawUrl: string): Promise<{ url: URL; dispatcher: Agent }> {
  const { url, pinnedIp, pinnedFamily } = await resolveAndValidateTarget(rawUrl);
  const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(pinnedIp, pinnedFamily) } });
  return { url, dispatcher };
}

/** Result of a guarded fetch. `body` is the parsed JSON when possible, else the raw text. */
export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes: number;
}

/**
 * Builds an undici `connect.lookup` hook that ignores whatever hostname the socket layer
 * asks it to resolve and always answers with the pre-validated, pinned address. This is
 * the mechanism that makes the SSRF check binding rather than advisory: the TCP connect
 * undici performs for this request never calls `dns.lookup` for real, so a rebinding DNS
 * server that would answer differently on a second query never gets a chance to run —
 * the socket connects to exactly the IP `resolveAndValidateTarget` already checked.
 *
 * TLS is unaffected by this: undici derives the SNI `servername` (and the `Host` header)
 * from the original hostname independently of `connect.lookup`, which only overrides
 * address resolution — so HTTPS certificate hostname verification still checks the real
 * hostname, not the pinned IP.
 *
 * Node's `net` connector always invokes a custom `lookup` with `{ all: true }` (it runs
 * its own Happy-Eyeballs-style address selection), so the callback must be answered with
 * an array of `{ address, family }`, not the single `(err, address, family)` triple used
 * by the public `dns.lookup` callback shape — this was confirmed empirically against the
 * installed undici/Node combination, since `net.LookupFunction`'s type signature allows
 * either shape depending on the caller.
 */
function createPinnedLookup(pinnedIp: string, pinnedFamily: 4 | 6) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ): void => {
    callback(null, [{ address: pinnedIp, family: pinnedFamily }]);
  };
}

/**
 * Guarded server-side fetch for tool execution: SSRF-checked, timed out, size-capped,
 * and non-redirect-following (a redirect is refused rather than re-guarded, keeping the
 * guard total). The validated address is pinned to the actual connection via undici's
 * `connect.lookup` hook (see `createPinnedLookup`), so the request cannot be steered to a
 * different address by a second, independent DNS resolution (DNS rebinding).
 *
 * Uses undici's low-level `request()` API rather than its WHATWG-spec `fetch()` wrapper:
 * on the Node version this project runs against, `fetch()`'s internal abort-listener
 * cleanup throws (`removeAbortListener is not a function`) for every call made from
 * inside Jest's test realm — a real incompatibility between the installed `undici`
 * version's `fetch()` implementation and this environment, unrelated to the SSRF logic
 * here. `request()` is the stable primitive `fetch()` itself is built on, fully supports
 * the `dispatcher` option this guard depends on, and does not hit that code path.
 * `request()` also defaults `maxRedirections` to `0`, i.e. it already never follows
 * redirects on its own — matching this guard's "refuse, don't re-guard" policy for free.
 *
 * @param rawUrl - The absolute http(s) URL to fetch.
 * @param init - Standard `RequestInit`-shaped method/headers/body.
 * @param timeoutMs - Overrides the default 10s abort timeout. Test-only knob (e.g. proving
 *   the abort path normalizes to `SsrfError` without waiting out the real default) — app code
 *   should not need to pass this.
 * @throws {SsrfError} On guard failure, timeout, oversize body, or a redirect response.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  timeoutMs: number = TIMEOUT_MS,
): Promise<SafeFetchResult> {
  const { url, pinnedIp, pinnedFamily } = await resolveAndValidateTarget(rawUrl);
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(pinnedIp, pinnedFamily) },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = (init.method ?? 'GET').toUpperCase() as Dispatcher.HttpMethod;
    const res = await undiciRequest(url, {
      method,
      headers: normalizeHeaders(init.headers),
      body: init.body as string | Buffer | undefined,
      dispatcher,
      signal: controller.signal,
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      await res.body.dump();
      throw new SsrfError('Redirects are not followed.');
    }
    const text = await res.body.text();
    if (text.length > MAX_BYTES) throw new SsrfError('Response exceeds size cap.');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { status: res.statusCode, headers, body, bytes: text.length };
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    // The abort fired because our own timer tripped (not because a caller-supplied signal
    // was aborted — safeFetch doesn't accept one), so any rejection while `controller.signal`
    // is aborted is our timeout, not a caller cancellation. undici/Node surface this as a raw
    // DOMException/AbortError, not SsrfError — normalize it so every guard failure looks the
    // same to callers.
    if (controller.signal.aborted) throw new SsrfError('Request timed out.');
    throw err;
  } finally {
    clearTimeout(timer);
    await dispatcher.close();
  }
}

/** Normalizes the DOM-style `HeadersInit` shapes callers may pass into a plain record. */
function normalizeHeaders(headersInit: RequestInit['headers']): Record<string, string> | undefined {
  if (!headersInit) return undefined;
  if (headersInit instanceof Headers) {
    const out: Record<string, string> = {};
    headersInit.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(headersInit)) {
    return Object.fromEntries(headersInit);
  }
  return { ...headersInit } as Record<string, string>;
}
