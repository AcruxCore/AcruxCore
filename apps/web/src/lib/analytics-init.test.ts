// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initAnalytics } from './analytics';

const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js?id=G-TEST123';

/** The gtag.js `<script>` element, if it has been injected yet. */
function gtagScript(): HTMLScriptElement | null {
  return document.querySelector(`script[src="${GTAG_SRC}"]`);
}

/** The command names queued so far, in order (`consent`, `js`, `config`). */
function queuedCommands(): unknown[] {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as IArguments)[0]);
}

/**
 * gtag.js is 194 KiB of script. It used to be appended during bootstrap, so it
 * competed with the page's own JavaScript for the network and main thread
 * before first paint. The consent defaults must still be queued first and
 * immediately (Consent Mode v2 reads them before anything else); only the
 * script tag waits.
 */
describe('initAnalytics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('PROD', true);
    window.__ACRUXCORE_CONFIG__ = { ga4MeasurementId: 'G-TEST123' };
    window.dataLayer = [];
    delete window.gtag;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    gtagScript()?.remove();
    vi.restoreAllMocks();
  });

  it('queues the consent default synchronously, before any other command', () => {
    initAnalytics();

    expect(queuedCommands()[0]).toBe('consent');
    expect(Array.from(window.dataLayer?.[0] as IArguments)[1]).toBe('default');
    expect(queuedCommands()).toContain('config');
  });

  it('does not inject the gtag.js script during bootstrap', () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');

    initAnalytics();

    expect(gtagScript()).toBeNull();
  });

  it('injects the script once the window load event has fired and the browser is idle', async () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    initAnalytics();
    expect(gtagScript()).toBeNull();

    window.dispatchEvent(new Event('load'));
    await vi.runAllTimersAsync();

    expect(gtagScript()).not.toBeNull();
    expect(gtagScript()?.async).toBe(true);
  });

  it('injects the script when bootstrap runs after load has already fired', async () => {
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');

    initAnalytics();
    await vi.runAllTimersAsync();

    expect(gtagScript()).not.toBeNull();
  });
});
