/**
 * Best-effort display label for a BYO provider, derived from its base URL's
 * hostname — not a validated enum. Used only for the span's `provider` field
 * so gateway and BYO traces can be filtered/grouped the same way in the
 * dashboard.
 *
 * @param baseUrl - The BYO provider's base URL.
 * @returns The base URL's hostname, unmodified.
 */
export function inferProviderName(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}
