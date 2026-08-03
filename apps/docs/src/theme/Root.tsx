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
      <div
        role="region"
        aria-label="Cookie consent"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 200,
          borderTop: '1px solid var(--ifm-toc-border-color)',
          background: 'var(--ifm-background-surface-color)',
          padding: '1rem 1.5rem',
          boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.08)',
        }}
      >
        <div
          style={{
            maxWidth: 960,
            margin: '0 auto',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
          }}
        >
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            We use cookies to understand site traffic with Google Analytics. We only set analytics
            cookies if you accept — see our <Link to="https://acruxcore.com/privacy">Privacy Policy</Link>.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flex: 'none' }}>
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
