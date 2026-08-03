/** Fallback destination when no valid `next` is supplied. */
export const DEFAULT_NEXT = '/prompts';

/**
 * Validates a post-authentication redirect target.
 *
 * Only same-origin absolute *paths* are allowed. Anything else — an absolute
 * URL, a protocol-relative `//host` (which browsers treat as cross-origin), a
 * backslash-prefixed variant Windows browsers normalise to `//`, or a missing
 * value — collapses to {@link DEFAULT_NEXT}. Without this, a crafted
 * `?next=https://evil.example` would redirect a just-authenticated user
 * off-site (open redirect).
 *
 * @param raw - Untrusted value from a query string.
 * @returns A safe in-app path, always beginning with a single `/`.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT;

  // The WHATWG URL parser removes ASCII tab, LF and CR from a URL *before*
  // interpreting it, so `/<tab>/evil.example` becomes `//evil.example` — a
  // protocol-relative, cross-origin URL — by the time a browser acts on it.
  // Validating the raw string would therefore approve a value that means
  // something entirely different once navigated to, so strip those characters
  // first and check (and return) what the browser will actually see.
  const cleaned = raw.replace(/[\t\r\n]/g, '');

  if (!cleaned.startsWith('/')) return DEFAULT_NEXT;
  if (cleaned.startsWith('//') || cleaned.startsWith('/\\')) return DEFAULT_NEXT;
  return cleaned;
}
