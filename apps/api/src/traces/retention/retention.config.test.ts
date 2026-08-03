import { loadRetentionConfig, DEFAULT_RETENTION_DAYS, DEFAULT_PURGE_CRON } from './retention.config';

describe('loadRetentionConfig', () => {
  const ORIGINAL_ENV = process.env;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.TRACE_PAYLOAD_PURGE_ENABLED;
    delete process.env.TRACE_PAYLOAD_RETENTION_DAYS;
    delete process.env.TRACE_PAYLOAD_PURGE_CRON;
    delete process.env.NODE_ENV;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults disabled outside production, with the default retention window and cron', () => {
    process.env.NODE_ENV = 'test';
    const config = loadRetentionConfig();
    expect(config.enabled).toBe(false);
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(config.cron).toBe(DEFAULT_PURGE_CRON);
  });

  it('defaults enabled in production', () => {
    process.env.NODE_ENV = 'production';
    expect(loadRetentionConfig().enabled).toBe(true);
  });

  it('TRACE_PAYLOAD_PURGE_ENABLED overrides the environment-based default either way', () => {
    process.env.NODE_ENV = 'production';
    process.env.TRACE_PAYLOAD_PURGE_ENABLED = 'false';
    expect(loadRetentionConfig().enabled).toBe(false);

    process.env.NODE_ENV = 'test';
    process.env.TRACE_PAYLOAD_PURGE_ENABLED = 'true';
    expect(loadRetentionConfig().enabled).toBe(true);
  });

  it('TRACE_PAYLOAD_RETENTION_DAYS and TRACE_PAYLOAD_PURGE_CRON override their defaults', () => {
    process.env.TRACE_PAYLOAD_RETENTION_DAYS = '30';
    process.env.TRACE_PAYLOAD_PURGE_CRON = '0 4 * * *';
    const config = loadRetentionConfig();
    expect(config.retentionDays).toBe(30);
    expect(config.cron).toBe('0 4 * * *');
  });

  it('falls back to the default retention window when the env var is an empty string, instead of purging everything', () => {
    // Regression: some deployment tooling exports "" instead of unsetting a var.
    // "" is not null/undefined so `?? DEFAULT` never fired, and Number('') === 0,
    // which would make the purge cutoff "right now" — wiping all payload data.
    process.env.TRACE_PAYLOAD_RETENTION_DAYS = '';
    const config = loadRetentionConfig();
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the default retention window when the env var is "0"', () => {
    process.env.TRACE_PAYLOAD_RETENTION_DAYS = '0';
    const config = loadRetentionConfig();
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the default retention window when the env var is negative', () => {
    process.env.TRACE_PAYLOAD_RETENTION_DAYS = '-5';
    const config = loadRetentionConfig();
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the default retention window when the env var is non-numeric, instead of hanging the purge job on NaN', () => {
    process.env.TRACE_PAYLOAD_RETENTION_DAYS = 'not-a-number';
    const config = loadRetentionConfig();
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(Number.isFinite(config.retentionDays)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to the default retention window when the env var is a non-integer', () => {
    process.env.TRACE_PAYLOAD_RETENTION_DAYS = '30.5';
    const config = loadRetentionConfig();
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('accepts the documented minimum of 1 day without warning', () => {
    process.env.TRACE_PAYLOAD_RETENTION_DAYS = '1';
    const config = loadRetentionConfig();
    expect(config.retentionDays).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
