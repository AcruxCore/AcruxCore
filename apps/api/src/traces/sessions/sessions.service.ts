import { NotFoundError } from '../../shared/errors';
import { SessionsRepository } from './sessions.repository';
import type {
  SessionListQuery,
  SessionListResponse,
  SessionDetailResponse,
} from './sessions.types';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Business logic for the sessions read surface. Read-only, team-scoped. */
export class SessionsService {
  constructor(private readonly repo: SessionsRepository) {}

  /**
   * Lists the team's sessions. Defaults the window to the last 30 days when
   * `from`/`to` are omitted (`to = now`, `from = to − 30d`).
   *
   * @param teamId - Team scope.
   * @param query - Validated list query.
   * @returns Paginated envelope `{ data, total, page, limit }`.
   */
  async listSessions(teamId: string, query: SessionListQuery): Promise<SessionListResponse> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS);

    const { data, total } = await this.repo.listSessions(teamId, {
      from,
      to,
      page: query.page,
      limit: query.limit,
      q: query.q,
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Returns one session's summary plus its traces.
   *
   * @param teamId - Team scope.
   * @param sessionId - The `session_id` string.
   * @returns `{ session, traces }`.
   * @throws {NotFoundError} If the team has no trace with that `session_id`.
   */
  async getSession(teamId: string, sessionId: string): Promise<SessionDetailResponse> {
    const result = await this.repo.getSession(teamId, sessionId);
    if (!result) throw new NotFoundError('Session not found.');
    return result;
  }
}
