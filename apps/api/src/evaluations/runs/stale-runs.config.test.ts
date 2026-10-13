import {
  loadStaleRunConfig,
  DEFAULT_STALE_RUN_MINUTES,
  DEFAULT_STALE_RUN_CRON,
  MIN_STALE_RUN_MINUTES,
} from './stale-runs.config';

describe('loadStaleRunConfig', () => {
  const ORIGINAL_ENV = process.env;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.EVAL_STALE_RUN_REAPER_ENABLED;
    delete process.env.EVAL_STALE_RUN_MINUTES;
    delete process.env.EVAL_STALE_RUN_CRON;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('is enabled by default, with the default window and cron', () => {
    expect(loadStaleRunConfig()).toEqual({
      enabled: true,
      staleMinutes: DEFAULT_STALE_RUN_MINUTES,
      cron: DEFAULT_STALE_RUN_CRON,
    });
  });

  it('EVAL_STALE_RUN_REAPER_ENABLED=false is the kill switch', () => {
    process.env.EVAL_STALE_RUN_REAPER_ENABLED = 'false';
    expect(loadStaleRunConfig().enabled).toBe(false);
  });

  it('reads a valid window and cron from the environment', () => {
    process.env.EVAL_STALE_RUN_MINUTES = '45';
    process.env.EVAL_STALE_RUN_CRON = '*/5 * * * *';
    expect(loadStaleRunConfig()).toMatchObject({ staleMinutes: 45, cron: '*/5 * * * *' });
  });

  it.each(['', '0', 'abc', '2.5', String(MIN_STALE_RUN_MINUTES - 1)])(
    'falls back to the default and warns for an unsafe window of "%s"',
    (raw) => {
      process.env.EVAL_STALE_RUN_MINUTES = raw;
      expect(loadStaleRunConfig().staleMinutes).toBe(DEFAULT_STALE_RUN_MINUTES);
      expect(warnSpy).toHaveBeenCalled();
    },
  );
});
