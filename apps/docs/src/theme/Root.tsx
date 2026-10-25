import { type ReactNode, useEffect, useState } from 'react';
import Link from '@docusaurus/Link';

type ConsentValue = 'granted' | 'denied';

/** Must match apps/web/src/lib/analytics.ts's ANALYTICS_CONSENT_COOKIE exactly. */
const CONSENT_COOKIE = 'acx_analytics_consent';
const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Picks the cookie `domain` attribute so the choice is visible to every
 * `acruxcore.com` subdomain, or `undefined` on any other host (localhost,
 * preview deploys) where a parent-domain cookie cannot be set.
 */
function consentCookieDomain(hostname: string): string | undefined {
  return hostname === 'acruxcore.com' || hostname.endsWith('.acruxcore.com') ? '.acruxcore.com' : undefined;
}

function readConsent(): ConsentValue | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CONSENT_COOKIE}=(granted|denied)`));
  return match ? (match[1] as ConsentValue) : null;
}

function writeConsent(value: ConsentValue): void {
  const domain = consentCookieDomain(window.location.hostname);
  const parts = [`${CONSENT_COOKIE}=${value}`, 'path=/', `max-age=${CONSENT_MAX_AGE_SECONDS}`, 'SameSite=Lax'];
  if (domain) parts.push(`domain=${domain}`);
  if (window.location.protocol === 'https:') parts.push('Secure');
  document.cookie = parts.join('; ');
  window.gtag?.('consent', 'update', { analytics_storage: value });
}

/**
 * Docusaurus root-level wrapper, applied automatically by file convention
 * (see https://docusaurus.io/docs/swizzling#wrapping-a-theme-component — no
 * `docusaurus swizzle` needed for `Root`). Renders the same cookie consent
 * banner as the marketing site (apps/web/src/ui/CookieConsentBanner.tsx),
 * sharing its cookie name and `.acruxcore.com` domain so a choice on either
 * subdomain covers both.
 *
 * @param children - The rest of the Docusaurus app.
 * @returns `children` plus the consent banner when no choice is stored yet.
 */
export default function Root({ children }: { children: ReactNode }): ReactNode {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(readConsent() === null);
  }, []);

  const choose = (value: ConsentValue) => {
    writeConsent(value);
    setVisible(false);
  };

  if (!visible) return children;

  return (
    <>
      {children}
      {/* Layout lives in custom.css (.acx-consent): on a phone it is one row,
          a short sentence beside the buttons, and on touch screens the buttons
          are 44px tall. */}
      <div role="region" aria-label="Cookie consent" className="acx-consent">
        <div className="acx-consent__inner">
          <p className="acx-consent__text">
            <span className="acx-consent__short">We set analytics cookies only if you accept. </span>
            <span className="acx-consent__long">
              We use cookies to understand site traffic with Google Analytics. We only set analytics
              cookies if you accept — see our{' '}
            </span>
            <Link to="https://acruxcore.com/privacy">Privacy Policy</Link>.
          </p>
          <div className="acx-consent__actions">
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => choose('denied')}
            >
              Decline
            </button>
            <button
              type="button"
              className="button button--primary button--sm"
              onClick={() => choose('granted')}
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
