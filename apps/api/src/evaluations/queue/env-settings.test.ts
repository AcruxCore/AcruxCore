import { evalCallDeadlineMs } from './eval-call-deadline';
import { perTeamInFlightCap } from './team-slots';

/**
 * The eval queue's env settings read whole numbers the same way trace search does: a
 * value that is set but unusable is ignored with a warning naming it, so an operator who
 * mistypes one finds out instead of silently running on the default.
 */
describe('eval queue env settings', () => {
  const saved = { ...process.env };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    process.env = { ...saved };
  });

  it.each(['abc', '2.5', '0', '-3'])('warns about and ignores EVAL_CALL_DEADLINE_MS=%s', (raw) => {
    process.env.EVAL_CALL_DEADLINE_MS = raw;
    expect(evalCallDeadlineMs()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVAL_CALL_DEADLINE_MS'));
  });

  it.each(['abc', '2.5', '0'])('warns about and ignores EVAL_PER_TEAM_MAX_IN_FLIGHT=%s', (raw) => {
    process.env.EVAL_PER_TEAM_MAX_IN_FLIGHT = raw;
    expect(perTeamInFlightCap(4)).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVAL_PER_TEAM_MAX_IN_FLIGHT'));
  });

  it('reads good values and says nothing about unset ones', () => {
    process.env.EVAL_CALL_DEADLINE_MS = '20000';
    process.env.EVAL_PER_TEAM_MAX_IN_FLIGHT = '3';
    expect(evalCallDeadlineMs()).toBe(20_000);
    expect(perTeamInFlightCap(4)).toBe(3);
    delete process.env.EVAL_CALL_DEADLINE_MS;
    delete process.env.EVAL_PER_TEAM_MAX_IN_FLIGHT;
    expect(evalCallDeadlineMs()).toBeUndefined();
    expect(perTeamInFlightCap(4)).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
