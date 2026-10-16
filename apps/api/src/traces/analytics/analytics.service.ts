import { AnalyticsRepository } from './analytics.repository';
import type { AnalyticsQuery, AnalyticsResponse, ScoresQuery, ScoresResponse } from './analytics.types';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Business logic for trace analytics. Read-only, team-scoped. */
export class AnalyticsService {
  constructor(private readonly repo: AnalyticsRepository) {}

  /**
   * Builds the analytics response. Defaults the window to the last 30 days when
   * `from`/`to` are omitted (the window is applied to `started_at`). Dates are
   * echoed back as YYYY-MM-DD.
   *
   * @param teamId - Team scope.
   * @param query - Validated analytics query.
   * @returns Totals + grouped buckets over the resolved window.
   */
  async getAnalytics(teamId: string, query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS);

    const filters = { from, to, kind: query.kind, model: query.model };
    const [{ totals, buckets }, costPerTrace] = await Promise.all([
      this.repo.bucket(teamId, { ...filters, groupBy: query.group_by }),
      this.repo.costPerTrace(teamId, filters),
    ]);

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      groupBy: query.group_by,
      totals,
      costPerTrace,
      buckets,
    };
  }

  /**
   * Quality scores over a window: thumbs feedback and online-eval verdicts, per rule and
   * per day. Defaults to the last 30 days, like {@link getAnalytics}.
   *
   * @param teamId - Team scope.
   * @param query - Validated window.
   * @returns Totals, one entry per rule with a verdict, and a daily trend.
   */
  async getScores(teamId: string, query: ScoresQuery): Promise<ScoresResponse> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS);
    const { feedback, rules, days } = await this.repo.scores(teamId, from, to);
    return {
      from: from.toISOString().slice(0, 10),
      // `to` is exclusive, so the last day the window holds is the day of the moment before it.
      to: new Date(to.getTime() - 1).toISOString().slice(0, 10),
      feedback,
      rules,
      days,
    };
  }
}
