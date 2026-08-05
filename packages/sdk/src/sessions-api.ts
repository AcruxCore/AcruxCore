import type { SessionDetailResult, SessionListOptions, SessionListResult } from './types';
import type { NamespaceHost } from './host';

/**
 * The subset of the client this namespace needs.
 *
 * Declared structurally rather than importing `acruxcore`, which would be a runtime
 * circular import: the client constructs this namespace.
 */
export type SessionsNamespaceHost = NamespaceHost;

/**
 * The sessions read surface, reached as `hub.sessions`. Sessions are mounted at
 * `/api/v1/sessions` — a sibling path to `/api/v1/traces`, not nested under it —
 * so this is its own namespace rather than folded into {@link TracesNamespace}.
 */
export class SessionsNamespace {
  private readonly client: SessionsNamespaceHost;

  /**
   * @param client - The owning client, used for its request/parse helpers.
   */
  constructor(client: SessionsNamespaceHost) {
    this.client = client;
  }

  /**
   * Lists the team's sessions (rolled up by `sessionId`), newest-activity-first.
   * Wraps `GET /sessions`.
   *
   * @param options - Optional date range, pagination, and a substring filter on
   *   the session id. When omitted, the window defaults to the last 30 days,
   *   `page` to 1, and `limit` to 20 (server-side defaults).
   * @returns `{ data, total, page, limit }` — one entry per session.
   * @throws {acruxcoreError} API_ERROR — 400 `VALIDATION_ERROR` for an
   *   unparseable `from`/`to`, or `limit` over 100.
   */
  async list(options?: SessionListOptions): Promise<SessionListResult> {
    const params = new URLSearchParams();
    if (options?.from !== undefined) params.set('from', options.from);
    if (options?.to !== undefined) params.set('to', options.to);
    if (options?.page !== undefined) params.set('page', String(options.page));
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.q !== undefined) params.set('q', options.q);

    const qs = params.toString();
    const response = await this.client._request('GET', `/sessions${qs ? `?${qs}` : ''}`, undefined, 'listing sessions');
    return (await this.client._parseJsonOrThrow(response, 'listing sessions')) as SessionListResult;
  }

  /**
   * Reads one session's rolled-up summary plus every trace in it. Wraps
   * `GET /sessions/:id`.
   *
   * @param sessionId - The caller-chosen session id (not a UUID — it can
   *   contain characters needing encoding, so this is always
   *   `encodeURIComponent`-ed).
   * @returns `{ session, traces }`. `traces` items are {@link SessionTraceItem},
   *   NOT {@link TraceSummary} — they additionally carry `tags`.
   * @throws {acruxcoreError} API_ERROR with `statusCode` 404 if the team has no
   *   trace with that session id.
   */
  async get(sessionId: string): Promise<SessionDetailResult> {
    const response = await this.client._request(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      'reading session',
    );
    return (await this.client._parseJsonOrThrow(response, 'reading session')) as SessionDetailResult;
  }
}
