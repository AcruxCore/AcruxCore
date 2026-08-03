import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from './Button';
import { readAnalyticsConsent, setAnalyticsConsent } from '@/lib/analytics';

/** Dispatch this to reopen the banner after a choice was already made — see the footer's "Cookie preferences" link. */
export const REOPEN_COOKIE_BANNER_EVENT = 'acx:reopen-cookie-banner';

/**
 * Site-wide cookie consent banner gating the GA4 `analytics_storage` cookie.
 * Shows once, on first visit with no stored choice, above every route
 * (marketing and app alike, since GA4 loads for both). Mounted once in
 * `main.tsx`.
 *
 * @returns The banner, or `null` once a choice has been recorded.
 */
export function CookieConsentBanner() {
  const [visible, setVisible] = useState(() => readAnalyticsConsent() === null);

  useEffect(() => {
    const reopen = () => setVisible(true);
    window.addEventListener(REOPEN_COOKIE_BANNER_EVENT, reopen);
    return () => window.removeEventListener(REOPEN_COOKIE_BANNER_EVENT, reopen);
  }, []);

  if (!visible) return null;

  const choose = (value: 'granted' | 'denied') => {
    setAnalyticsConsent(value);
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-line bg-surface px-4 py-4 shadow-xl sm:px-6"
    >
      <div className="mx-auto flex max-w-4xl flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-muted">
          We use cookies to understand site traffic with Google Analytics. We only set analytics
          cookies if you accept — see our{' '}
          <Link to="/privacy" className="text-accent hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
        <div className="flex flex-none gap-2">
          <Button variant="default" size="sm" onClick={() => choose('denied')}>
            Decline
          </Button>
          <Button variant="primary" size="sm" onClick={() => choose('granted')}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
