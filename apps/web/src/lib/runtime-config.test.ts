import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRuntimeConfig } from './runtime-config';

describe('readRuntimeConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the values the container wrote into window.__ACRUXCORE_CONFIG__', () => {
    vi.stubGlobal('window', {
      __ACRUXCORE_CONFIG__: {
        sentryWebDsn: 'https://abc@o1.ingest.sentry.io/2',
        ga4MeasurementId: 'G-TEST123',
      },
    } as unknown as Window);

    expect(readRuntimeConfig()).toEqual({
      sentryWebDsn: 'https://abc@o1.ingest.sentry.io/2',
      ga4MeasurementId: 'G-TEST123',
    });
  });

  it('returns empty strings when /runtime-config.js never ran', () => {
    vi.stubGlobal('window', {} as Window);
    expect(readRuntimeConfig()).toEqual({ sentryWebDsn: '', ga4MeasurementId: '' });
  });

  it('ignores a value that is not a string, so a bad config cannot reach Sentry or gtag', () => {
    vi.stubGlobal('window', {
      __ACRUXCORE_CONFIG__: { sentryWebDsn: 42, ga4MeasurementId: { id: 'G-X' } },
    } as unknown as Window);
    expect(readRuntimeConfig()).toEqual({ sentryWebDsn: '', ga4MeasurementId: '' });
  });

  it('returns empty strings outside a browser (the prerender runs in Node)', () => {
    expect(readRuntimeConfig()).toEqual({ sentryWebDsn: '', ga4MeasurementId: '' });
  });
});
