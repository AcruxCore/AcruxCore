import { useEffect, useState } from 'react';
import { fetchAuthCapabilities, type AuthCapabilities } from '@/api/auth';

/**
 * Module-level cache. Capabilities are fixed for the life of the server process,
 * so the login and signup pages should not each pay for their own request — and
 * a user bouncing between the two should not re-fetch on every navigation.
 */
let cached: AuthCapabilities | null = null;
let inFlight: Promise<AuthCapabilities> | null = null;

function load(): Promise<AuthCapabilities> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= fetchAuthCapabilities()
    .then((capabilities) => {
      cached = capabilities;
      return capabilities;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Reads which sign-in methods this deployment supports.
 *
 * Returns `null` until the answer arrives, and also if the request fails.
 * Callers treat `null` as "do not offer the optional methods yet": rendering a
 * Google button optimistically and hiding it a moment later would flash a
 * control that may not work at all, which is worse than showing it slightly
 * late. Email and password never depend on this.
 *
 * @returns The capabilities, or `null` while unknown.
 */
export function useAuthCapabilities(): AuthCapabilities | null {
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(cached);

  useEffect(() => {
    if (capabilities) return;
    let active = true;
    load()
      .then((result) => {
        if (active) setCapabilities(result);
      })
      .catch(() => {
        // Leave it null. The email/password form below is unaffected, and the
        // next page load retries.
      });
    return () => {
      active = false;
    };
  }, [capabilities]);

  return capabilities;
}
