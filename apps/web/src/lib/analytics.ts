export type ConsentValue = 'granted' | 'denied';

/**
 * Name of the first-party cookie that records the visitor's analytics
 * consent choice. Shared verbatim with the docs site's own consent banner
 * (`apps/docs/src/theme/Root.tsx`) so a choice made on one `acruxcore.com`
 * subdomain is honored on the other without a re-prompt.
 */
export const ANALYTICS_CONSENT_COOKIE = 'acx_analytics_consent';

const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const GA4_MEASUREMENT_ID = import.meta.env.VITE_GA4_MEASUREMENT_ID as string | undefined;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

type GtagFn = (...args: unknown[]) => void;

/**
 * The `gtag()` command queue stub, byte-for-byte equivalent to Google's own
 * snippet.
 *
 * **`arguments` here is load-bearing — do not "modernize" it into a rest
 * parameter.** `gtag.js` replaces `dataLayer.push` with its own processor and
 * tells a *command* (`['config', 'G-…']`) apart from an ordinary data-layer
 * *object* by checking that the pushed value is a real `arguments` object
 * (`[object Arguments]`). A plain array — which is what a rest parameter gives
 * you — is silently ignored: the tag loads, the queue fills, and not one hit is
 * ever sent. That exact mistake made this site report zero traffic while GA4's
 * own "Test your website" check still passed, because the check only looks for
 * the script tag.
 */
export const gtag: GtagFn = function () {
  window.dataLayer = window.dataLayer ?? [];
  // eslint-disable-next-line prefer-rest-params -- see the note above; a rest array is not a command
  window.dataLayer.push(arguments);
};

/**
 * Picks the cookie `domain` attribute for the consent cookie.
 *
 * @param hostname - `window.location.hostname` of the current page.
 * @returns `.acruxcore.com` in production, so the cookie is visible to every
 *   subdomain (`acruxcore.com`, `docs.acruxcore.com`); `undefined` anywhere
 *   else (localhost, preview deploys), where a parent-domain cookie cannot be
 *   set and the browser should default to the current host instead.
 */
export function consentCookieDomain(hostname: string): string | undefined {
  return hostname === 'acruxcore.com' || hostname.endsWith('.acruxcore.com') ? '.acruxcore.com' : undefined;
}

/**
 * Extracts the stored consent value from a raw `document.cookie` string.
 *
 * @param cookieHeader - The full `document.cookie` value.
 * @returns `'granted'` or `'denied'` if present, otherwise `null`.
 */
export function parseConsentCookie(cookieHeader: string): ConsentValue | null {
  const match = cookieHeader.match(new RegExp(`(?:^|; )${ANALYTICS_CONSENT_COOKIE}=(granted|denied)`));
  return match ? (match[1] as ConsentValue) : null;
}

/**
 * Builds the `document.cookie` assignment string for a consent choice.
 *
 * @param value - `'granted'` or `'denied'`.
 * @param hostname - `window.location.hostname`, used to pick the cookie domain.
 * @param isHttps - `window.location.protocol === 'https:'`; adds `Secure` when true.
 * @returns The full cookie string, ready to assign to `document.cookie`.
 */
export function buildConsentCookie(value: ConsentValue, hostname: string, isHttps: boolean): string {
  const domain = consentCookieDomain(hostname);
  const parts = [
    `${ANALYTICS_CONSENT_COOKIE}=${value}`,
    'path=/',
    `max-age=${CONSENT_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ];
  if (domain) parts.push(`domain=${domain}`);
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Reads the visitor's stored analytics consent choice, if any.
 *
 * @returns `'granted'` or `'denied'` if the cookie is set, otherwise `null`
 *   (the visitor has not made a choice yet and the banner should show).
 */
export function readAnalyticsConsent(): ConsentValue | null {
  return parseConsentCookie(document.cookie);
}

/**
 * Persists the visitor's analytics consent choice and, if GA4 already
 * bootstrapped in this session, pushes a live Consent Mode update so the
 * change takes effect without a page reload.
 *
 * @param value - `'granted'` to allow the `analytics_storage` cookie, `'denied'` to keep it blocked.
 */
export function setAnalyticsConsent(value: ConsentValue): void {
  document.cookie = buildConsentCookie(value, window.location.hostname, window.location.protocol === 'https:');

  if (window.gtag) {
    window.gtag('consent', 'update', { analytics_storage: value });
  }
}

/**
 * Boots Google Analytics 4 behind Google Consent Mode v2: `analytics_storage`
 * defaults to denied, so no analytics cookie is set until the visitor accepts
 * the cookie banner (or the shared `.acruxcore.com` consent cookie already
 * records an earlier "accept" from this or the docs subdomain). Call once,
 * as early as possible during app bootstrap.
 *
 * No-ops in local dev (`import.meta.env.PROD` false) and whenever
 * `VITE_GA4_MEASUREMENT_ID` is unset, so a dev build never reports traffic.
 */
export function initAnalytics(): void {
  if (!import.meta.env.PROD || !GA4_MEASUREMENT_ID) return;

  window.gtag = gtag;
  gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    wait_for_update: 500,
  });

  if (readAnalyticsConsent() === 'granted') {
    gtag('consent', 'update', { analytics_storage: 'granted' });
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`;
  document.head.appendChild(script);

  gtag('js', new Date());
  gtag('config', GA4_MEASUREMENT_ID);
}
