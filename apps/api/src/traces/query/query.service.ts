import { TraceQueryRepository } from './query.repository';
import { NotFoundError } from '../../shared/errors';
import { buildSpanTree } from './span-tree';
import { VersionsService } from '../../prompts/versions';
import { FeedbackService, FeedbackRepository } from '../feedback';
import type {
  TraceListQuery,
  TraceListResponse,
  TraceDetail,
  TraceSummary,
  PromptVersionTracesQuery,
} from './query.types';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Business logic for the trace query surface. Read-only, team-scoped. */
export class TraceQueryService {
  private readonly versions = new VersionsService();
  private readonly feedbackService = new FeedbackService(new FeedbackRepository());

  constructor(private readonly repo: TraceQueryRepository) {}

  /**
   * Lists traces for a team. Defaults the window to the last 30 days when
   * `from`/`to` are omitted; maps snake_case query params to the repository's
   * camelCase filter shape.
   *
   * @param teamId - Team scope.
   * @param query - Validated list query.
   * @returns Paginated envelope { data, total, page, limit }.
   */
  async listTraces(teamId: string, query: TraceListQuery): Promise<TraceListResponse> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS);

    const { data, total } = await this.repo.listTraces(teamId, {
      from,
      to,
      status: query.status,
      model: query.model,
      sessionId: query.session_id,
      promptVersionId: query.prompt_version_id,
      minLatencyMs: query.min_latency_ms,
      minCostUsd: query.min_cost_usd,
      minTokens: query.min_tokens,
      q: query.q,
      tags: query.tags,
      metadata: query.metadata,
      page: query.page,
      limit: query.limit,
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Assembles the full trace detail: the trace header, its spans built into a
   * parent/child tree (with captured payloads inlined where present), and the
   * trace's user feedback (newest-first).
   *
   * @param teamId - Team scope.
   * @param traceId - Internal trace UUID.
   * @returns The trace summary, its span tree, and its feedback list.
   * @throws {NotFoundError} If the trace is not in this team.
   */
  async getTrace(teamId: string, traceId: string): Promise<TraceDetail> {
    const result = await this.repo.getTrace(teamId, traceId);
    if (!result) throw new NotFoundError('Trace not found');

    const { trace, spans, payloads } = result;
    const summary: TraceSummary = {
      id: trace.id,
      name: trace.name,
      sessionId: trace.sessionId,
      status: trace.status,
      startedAt: trace.startedAt.toISOString(),
      endedAt: trace.endedAt ? trace.endedAt.toISOString() : null,
      spanCount: trace.spanCount,
      totalCostUsd: trace.totalCostUsd === null ? null : Number(trace.totalCostUsd),
      totalTokens: trace.totalTokens,
      tags: trace.tags,
      metadata: trace.metadata as Record<string, unknown>,
    };

    // T6: surface user feedback inside the trace detail (additive). The trace
    // was already resolved for this team above, so this is a harmless extra
    // read; FeedbackService.list re-checks team scope and returns [] when empty.
    const feedback = await this.feedbackService.list(teamId, traceId);

    return { trace: summary, spans: buildSpanTree(spans, payloads), feedback };
  }

  /**
   * Reverse lineage: lists traces whose spans used a prompt's specific version.
   * Resolves the version via Phase 1's team-scoped `VersionsService.getVersion`
   * (which throws NotFoundError if the prompt or version isn't in the team — this
   * is the 404 path), then queries spans by the resolved prompt_versions id.
   *
   * @param teamId - Team scope.
   * @param promptId - Prompt UUID from the path.
   * @param versionNumber - 1-based version number from the path.
   * @param query - Validated pagination.
   * @returns Paginated envelope { data, total, page, limit }.
   * @throws {NotFoundError} If the prompt or version is not in this team.
   */
  async tracesForPromptVersion(
    teamId: string,
    promptId: string,
    versionNumber: number,
    query: PromptVersionTracesQuery,
  ): Promise<TraceListResponse> {
    const version = await this.versions.getVersion(promptId, teamId, versionNumber);
    const { data, total } = await this.repo.tracesForPromptVersion(
      teamId,
      version.id,
      query.page,
      query.limit,
    );
    return { data, total, page: query.page, limit: query.limit };
  }
}
