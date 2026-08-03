import { NotFoundError } from '../../shared/errors';
import { UsageRepository } from './usage.repository';
import type {
  UsageQuery,
  RequestListQuery,
  UsageResponse,
  RequestListResponse,
  RequestListItem,
} from './usage.types';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Business logic for gateway usage analytics. Read-only, team-scoped. */
export class UsageService {
  constructor(private readonly repo: UsageRepository) {}

  /**
   * Builds the aggregated usage response. Defaults the window to the last 30 days
   * when `from`/`to` are omitted. Dates are echoed back as YYYY-MM-DD.
   *
   * @param teamId - Team scope.
   * @param query - Validated usage query.
   * @returns Totals + grouped buckets over the resolved window.
   */
  async getUsage(teamId: string, query: UsageQuery): Promise<UsageResponse> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS);

    const { totals, buckets } = await this.repo.aggregateUsage(
      teamId,
      from,
      to,
      query.group_by,
      query.virtual_key_id,
    );

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      groupBy: query.group_by,
      totals,
      buckets,
    };
  }

  /**
   * Returns a paginated slice of the request log.
   *
   * @param teamId - Team scope.
   * @param query - Validated list query.
   * @returns Paginated envelope { data, total, page, limit }.
   */
  async listRequests(teamId: string, query: RequestListQuery): Promise<RequestListResponse> {
    const { rows, total } = await this.repo.listRequests(
      teamId,
      {
        virtualKeyId: query.virtual_key_id,
        model: query.model,
        status: query.status,
        from: query.from,
        to: query.to,
      },
      query.page,
      query.limit,
    );
    return { data: rows, total, page: query.page, limit: query.limit };
  }

  /**
   * Returns a single request row scoped to the team.
   *
   * @param teamId - Team scope.
   * @param id - Request row id.
   * @returns The request detail.
   * @throws {NotFoundError} If no such row exists in this team.
   */
  async getRequestDetail(teamId: string, id: string): Promise<RequestListItem> {
    const row = await this.repo.getRequest(teamId, id);
    if (!row) throw new NotFoundError('Request not found.');
    return row;
  }
}
