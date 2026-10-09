/**
 * Deployment values the web bundle reads at page load instead of at build time.
 *
 * The web image is published once and run by everyone — production and every
 * self-hoster — so it cannot carry anyone's Sentry DSN or GA4 ID inside the
 * bundle. The container writes them into `/runtime-config.js` when it starts
 * (see `apps/web/docker/40-runtime-config.sh`), and `index.html` loads that
 * file before the app's own module script runs.
 */
export interface RuntimeConfig {
  /** Browser Sentry DSN, or `''` when error reporting is off. */
  sentryWebDsn: string;
  /** GA4 measurement ID (`G-…`), or `''` when analytics is off. */
  ga4MeasurementId: string;
}

declare global {
  interface Window {
    __ACRUXCORE_CONFIG__?: Record<string, unknown>;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads the values `/runtime-config.js` set on `window`.
 *
 * Never throws. A missing file, a missing key, or a non-string value all read
 * as `''`, which every caller treats as "feature off" — the same result as an
 * install that never configured Sentry or GA4.
 *
 * @returns Both values, each a string and possibly empty.
 */
export function readRuntimeConfig(): RuntimeConfig {
  const source = typeof window === 'undefined' ? undefined : window.__ACRUXCORE_CONFIG__;
  return {
    sentryWebDsn: asString(source?.sentryWebDsn),
    ga4MeasurementId: asString(source?.ga4MeasurementId),
  };
}
