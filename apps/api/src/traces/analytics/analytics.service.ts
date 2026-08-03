import { AnalyticsRepository } from './analytics.repository';
import type { AnalyticsQuery, AnalyticsResponse } from './analytics.types';

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

    const { totals, buckets } = await this.repo.bucket(teamId, {
      from,
      to,
      groupBy: query.group_by,
      kind: query.kind,
      model: query.model,
    });

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      groupBy: query.group_by,
      totals,
      buckets,
    };
  }
}
