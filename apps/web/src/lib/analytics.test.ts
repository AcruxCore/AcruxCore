import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConsentCookie, consentCookieDomain, gtag, parseConsentCookie } from './analytics';

describe('gtag', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Regression guard for the bug that made the site report zero GA4 traffic:
  // the stub pushed a rest-parameter array, and gtag.js only treats a pushed
  // value as a command when it is a real `arguments` object. Everything else
  // looked healthy — script loaded, queue filled — and no hit was ever sent.
  it('queues each command as an `arguments` object, which is what gtag.js recognizes', () => {
    vi.stubGlobal('window', {} as Window);

    gtag('config', 'G-TEST123');

    const queue = window.dataLayer ?? [];
    expect(queue).toHaveLength(1);
    expect(Object.prototype.toString.call(queue[0])).toBe('[object Arguments]');
    expect(Array.from(queue[0] as IArguments)).toEqual(['config', 'G-TEST123']);
  });

  it('appends to an existing queue rather than replacing it', () => {
    vi.stubGlobal('window', { dataLayer: ['existing'] } as unknown as Window);

    gtag('js', 'now');

    expect(window.dataLayer).toHaveLength(2);
    expect(window.dataLayer?.[0]).toBe('existing');
  });
});

describe('consentCookieDomain', () => {
  it('scopes to the parent domain on acruxcore.com and its subdomains', () => {
    expect(consentCookieDomain('acruxcore.com')).toBe('.acruxcore.com');
    expect(consentCookieDomain('docs.acruxcore.com')).toBe('.acruxcore.com');
    expect(consentCookieDomain('app.acruxcore.com')).toBe('.acruxcore.com');
  });

  it('is unset on any other host, so the cookie defaults to the current host', () => {
    expect(consentCookieDomain('localhost')).toBeUndefined();
    expect(consentCookieDomain('acruxcore.com.evil.example')).toBeUndefined();
    expect(consentCookieDomain('preview-123.pages.dev')).toBeUndefined();
  });
});

describe('parseConsentCookie', () => {
  it('reads granted or denied out of a multi-cookie header', () => {
    expect(parseConsentCookie('theme=dark; acx_analytics_consent=granted; other=x')).toBe('granted');
    expect(parseConsentCookie('acx_analytics_consent=denied')).toBe('denied');
  });

  it('returns null when the cookie is absent or holds an unrecognized value', () => {
    expect(parseConsentCookie('')).toBeNull();
    expect(parseConsentCookie('theme=dark')).toBeNull();
    expect(parseConsentCookie('acx_analytics_consent=maybe')).toBeNull();
  });
});

describe('buildConsentCookie', () => {
  it('includes the parent domain and Secure on the production host over https', () => {
    const cookie = buildConsentCookie('granted', 'acruxcore.com', true);
    expect(cookie).toContain('acx_analytics_consent=granted');
    expect(cookie).toContain('domain=.acruxcore.com');
    expect(cookie).toContain('Secure');
  });

  it('omits domain and Secure on localhost over http', () => {
    const cookie = buildConsentCookie('denied', 'localhost', false);
    expect(cookie).toContain('acx_analytics_consent=denied');
    expect(cookie).not.toContain('domain=');
    expect(cookie).not.toContain('Secure');
  });
});
