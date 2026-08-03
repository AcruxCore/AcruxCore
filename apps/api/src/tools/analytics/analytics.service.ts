import { ToolAnalyticsRepository } from './analytics.repository';
import type { AnalyticsQuery, ToolAnalyticsResponse } from './analytics.types';

/** Business logic for tool analytics (pure read — no writes, no side effects). */
export class ToolAnalyticsService {
  constructor(private readonly repo: ToolAnalyticsRepository) {}

  /**
   * Returns per-tool stats for the team over the optional `since`/`until` window.
   *
   * @param teamId - Team scope (isolation boundary — never taken from the request body/query).
   * @param query - Validated optional ISO-8601 window bounds.
   * @returns `{ data }` where `data` is one `ToolStat` per tool with at least one span in range.
   */
  async stats(teamId: string, query: AnalyticsQuery): Promise<ToolAnalyticsResponse> {
    const since = query.since ? new Date(query.since) : null;
    const until = query.until ? new Date(query.until) : null;
    return { data: await this.repo.statsByTool(teamId, since, until) };
  }
}
