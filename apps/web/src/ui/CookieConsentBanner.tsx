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

  // On a phone the full sentence wrapped to three lines above the buttons and
  // covered about a sixth of the screen. Below `sm` the banner is one row: a
  // short sentence beside the buttons. On touch screens the buttons grow to the
  // 44px touch-target size; a mouse keeps the compact 32px ones.
  const buttonSize = 'pointer-coarse:h-11 pointer-coarse:px-4';
  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-line bg-surface px-4 py-2.5 shadow-xl sm:px-6 sm:py-4"
    >
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
        <p className="text-[12.5px] leading-snug text-muted sm:text-[13px]">
          <span className="sm:hidden">We set analytics cookies only if you accept. </span>
          <span className="hidden sm:inline">
            We use cookies to understand site traffic with Google Analytics. We only set analytics
            cookies if you accept — see our{' '}
          </span>
          <Link to="/privacy" className="text-accent hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
        <div className="flex flex-none gap-2">
          <Button variant="default" size="sm" className={buttonSize} onClick={() => choose('denied')}>
            Decline
          </Button>
          <Button variant="primary" size="sm" className={buttonSize} onClick={() => choose('granted')}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
