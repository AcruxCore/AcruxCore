import { FeedbackRepository } from './feedback.repository';
import {
  CreateFeedbackDto,
  FeedbackDto,
  FeedbackListQuery,
  FeedbackListResponse,
  FeedbackSummary,
  FeedbackSummaryQuery,
  UpdateFeedbackDto,
} from './feedback.types';
import { FeedbackRow } from '../../shared/db/schema';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Business logic for trace feedback: verifies the trace belongs to the team,
 * resolves an optional span reference to a span within that trace, persists the
 * feedback, lists it, and computes the per-version/per-model summary.
 */
export class FeedbackService {
  constructor(private readonly repo: FeedbackRepository) {}

  /**
   * Attaches feedback to a trace (or one of its spans). `createdBy` is the caller's
   * user id, or null for a team-scoped API key / end user.
   *
   * @param teamId - Isolation boundary.
   * @param traceId - The trace to attach feedback to.
   * @param createdBy - The posting user's id, or null.
   * @param dto - Validated body (at least one of rating/label/comment; optional spanId ref + source).
   * @returns The created feedback, `spanId` echoed as the OTel ref.
   * @throws {NotFoundError} If the trace is not in the team.
   * @throws {AppError} 'INVALID_SPAN' (400) if `spanId` does not belong to the trace.
   */
  async create(
    teamId: string,
    traceId: string,
    createdBy: string | null,
    dto: CreateFeedbackDto,
  ): Promise<FeedbackDto> {
    const trace = await this.repo.findTraceForTeam(teamId, traceId);
    if (!trace) throw new NotFoundError('Trace not found.');

    let spanInternalId: string | null = null;
    let spanRef: string | null = null;
    if (dto.spanId !== undefined) {
      const span = await this.repo.findSpanInTrace(trace.id, dto.spanId);
      if (!span) {
        throw new AppError('spanId does not belong to this trace.', 400, 'INVALID_SPAN');
      }
      spanInternalId = span.id;
      spanRef = span.spanRef;
    }

    const row = await this.repo.create({
      teamId,
      traceId,
      spanId: spanInternalId,
      rating: dto.rating ?? null,
      label: dto.label ?? null,
      comment: dto.comment ?? null,
      source: dto.source,
      createdBy,
    });

    return this.toDto(row, spanRef);
  }

  /**
   * Edits an existing feedback row's rating/label/comment in place. Only the
   * row's original author (`createdBy`) may edit it — rows with `createdBy: null`
   * (posted via a team API key with no associated user) have no identifiable
   * author and so cannot be edited by anyone. Fields omitted from `patch` keep
   * their existing value; the merged result must still satisfy "at least one of
   * rating/label/comment" (mirroring the create validation).
   *
   * @param teamId - Isolation boundary.
   * @param traceId - The trace the feedback must belong to.
   * @param requesterId - The caller's user id, or null (team-scoped API key).
   * @param feedbackId - The feedback row to edit.
   * @param patch - Validated partial update (each field: unchanged / cleared / set).
   * @throws {NotFoundError} If the feedback row is not in this team+trace.
   * @throws {ForbiddenError} If the caller is not the row's original author.
   * @throws {ValidationError} If the merged result would leave nothing set.
   */
  async update(
    teamId: string,
    traceId: string,
    requesterId: string | null,
    feedbackId: string,
    patch: UpdateFeedbackDto,
  ): Promise<FeedbackDto> {
    const existing = await this.repo.findByIdForTeamTrace(teamId, traceId, feedbackId);
    if (!existing) throw new NotFoundError('Feedback not found.');

    if (requesterId === null || existing.createdBy !== requesterId) {
      throw new ForbiddenError('Only the original author can edit this feedback.');
    }

    const rating = 'rating' in patch ? patch.rating ?? null : existing.rating;
    const label = 'label' in patch ? patch.label ?? null : existing.label;
    const comment = 'comment' in patch ? patch.comment ?? null : existing.comment;

    if (rating === null && !label && !comment) {
      throw new ValidationError('Provide at least one of rating, label, or comment.');
    }

    const updated = await this.repo.update(feedbackId, { rating, label, comment });
    return this.toDto(updated, existing.span?.spanRef ?? null);
  }

  /**
   * Lists a trace's feedback newest-first.
   *
   * @param teamId - Isolation boundary.
   * @param traceId - The trace whose feedback to list.
   * @throws {NotFoundError} If the trace is not in the team.
   */
  async list(teamId: string, traceId: string): Promise<FeedbackDto[]> {
    const trace = await this.repo.findTraceForTeam(teamId, traceId);
    if (!trace) throw new NotFoundError('Trace not found.');

    const rows = await this.repo.listForTrace(teamId, traceId);
    return rows.map((r) => this.toDto(r, r.span?.spanRef ?? null));
  }

  /**
   * Lists a team's feedback newest-first across all traces, paginated — the raw
   * feed behind the feedback visualization page (T10).
   *
   * @param teamId - Team scope.
   * @param query - Validated page/limit.
   */
  async listForTeam(teamId: string, query: FeedbackListQuery): Promise<FeedbackListResponse> {
    const { data, total } = await this.repo.listForTeam(teamId, query.page, query.limit);
    return {
      data: data.map((r) => this.toDto(r, r.span?.spanRef ?? null)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Computes the average rating + counts grouped by prompt version (default) or
   * model over a date range. Defaults the window to the last 30 days.
   *
   * @param teamId - Team scope.
   * @param query - Optional `from`/`to` and `group_by`.
   */
  async summary(teamId: string, query: FeedbackSummaryQuery): Promise<FeedbackSummary> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - THIRTY_DAYS_MS);
    return this.repo.aggregate(teamId, { from, to, groupBy: query.group_by });
  }

  /**
   * Maps a DB row (+ resolved span ref) to the API DTO. `spanId` is the OTel ref,
   * never the internal UUID.
   *
   * @param row - The Prisma `trace_feedback` row.
   * @param spanRef - The span's OTel reference, or null for whole-trace feedback.
   */
  private toDto(row: FeedbackRow, spanRef: string | null): FeedbackDto {
    return {
      id: row.id,
      traceId: row.traceId,
      spanId: spanRef,
      rating: row.rating,
      label: row.label,
      comment: row.comment,
      source: row.source,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
