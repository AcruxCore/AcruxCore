import { runInTransaction } from '../../shared/db/unit-of-work';
import { SpansRepository } from '../spans';
import type { CreateSpanInput } from '../spans';
import { TraceSettingsRepository, shouldCapture } from '../settings';
import { AppError, NotFoundError, PayloadTooLargeError } from '../../shared/errors';
import type { IngestSpan, IngestTrace, IngestResponse } from './ingest.types';

/** Maximum spans accepted in one ingestion request (Phase-3 guard, FAQ / spec). */
const MAX_SPANS_PER_BATCH = 200;

/**
 * Ingests OTel-shaped trace batches into the T1 tables. Each trace is resolved
 * or created and its spans appended inside one `$transaction`; the request is
 * synchronous (FAQ Q6) and — unlike the gateway hook — **not** best-effort, since
 * no money ledger is involved.
 */
export class IngestService {
  /**
   * @param spans - T1's single writer of traces/spans/payloads (+ the T2 reads).
   * @param settings - T1's per-team payload-capture setting store.
   */
  constructor(
    private readonly spans: SpansRepository,
    private readonly settings: TraceSettingsRepository,
  ) {}

  /**
   * Validates and persists a batch of traces for a team.
   *
   * @param teamId - Team scope from the authenticated principal.
   * @param traces - The validated batch (Zod-parsed at the controller boundary).
   * @param opts - Optional flags.
   *        `idempotent` — when true, retried batches with the same spanIds are
   *        safe (used by the OTLP receiver); the native JSON path leaves this
   *        false and keeps its stricter create-and-fail behavior.
   *        `allowUnknownParents` — when true, a span whose `parentSpanId` is not
   *        (yet) a known span in this trace is stored as-is instead of rejected.
   *        Required by the OTLP receiver: OTel's `BatchSpanProcessor` queues a
   *        span on `onEnd` and flushes on a timer, so children are exported
   *        *before* their still-open parent for any trace outliving one flush
   *        interval. `parent_span_ref` carries no FK, and `buildSpanTree` treats
   *        a dangling ref as a root and re-parents once the parent lands, so the
   *        late parent heals the tree. The native JSON path leaves this false —
   *        there an unknown parent is a genuine client bug worth a 400.
   * @returns `{ accepted, traceIds }` — accepted is the total span count;
   *          traceIds are the resolved trace ids, one per input trace, in order.
   * @throws {PayloadTooLargeError} 413 if the batch exceeds the span cap.
   * @throws {NotFoundError} 404 if a supplied traceId belongs to another team.
   * @throws {AppError} 400 `INVALID_SPAN_PARENT` if a parentSpanId resolves to
   *         nothing and `opts.allowUnknownParents` is not set.
   */
  async ingest(
    teamId: string,
    traces: IngestTrace[],
    opts?: { idempotent?: boolean; allowUnknownParents?: boolean },
  ): Promise<IngestResponse> {
    const totalSpans = traces.reduce((n, t) => n + t.spans.length, 0);
    if (totalSpans > MAX_SPANS_PER_BATCH) {
      console.warn(
        `[trace] ingest rejected for team ${teamId}: ${totalSpans} spans exceeds cap of ${MAX_SPANS_PER_BATCH}`,
      );
      throw new PayloadTooLargeError(
        `Batch has ${totalSpans} spans; the per-request limit is ${MAX_SPANS_PER_BATCH}.`,
      );
    }

    // Team-level capture default is resolved once; each trace may override it.
    const teamSetting = (await this.settings.get(teamId))?.capturePayloads ?? true;

    const traceIds: string[] = [];
    for (const trace of traces) {
      traceIds.push(
        await this.ingestTrace(teamId, trace, teamSetting, {
          idempotent: opts?.idempotent ?? false,
          allowUnknownParents: opts?.allowUnknownParents ?? false,
        }),
      );
    }
    return { accepted: totalSpans, traceIds };
  }

  /**
   * Resolves/creates one trace and appends its spans (+ payloads) atomically.
   *
   * @param teamId - Team scope.
   * @param trace - One validated trace from the batch.
   * @param teamSetting - The team's default payload-capture flag.
   * @param mode - `idempotent`: upsert spans (safe on retry) instead of
   *        appending. `allowUnknownParents`: skip the parent-reference check —
   *        see {@link IngestService.ingest} for why the OTLP path needs it.
   * @returns The resolved trace id.
   */
  private async ingestTrace(
    teamId: string,
    trace: IngestTrace,
    teamSetting: boolean,
    mode: { idempotent: boolean; allowUnknownParents: boolean },
  ): Promise<string> {
    const capture = shouldCapture(teamSetting, trace.capturePayloads);
    const startedAt = this.earliestStart(trace.spans);

    return runInTransaction(async (tx) => {
      // ── Resolve or create the trace ───────────────────────────────────────
      let traceId: string;
      if (trace.traceId) {
        const existing = await this.spans.findTraceById(trace.traceId, tx);
        if (existing) {
          if (existing.teamId !== teamId) {
            // Never leak another team's trace, and never cross-tenant append.
            throw new NotFoundError('Trace not found.');
          }
          traceId = existing.id;
          if (trace.tags?.length || trace.metadata || trace.sessionId) {
            await this.spans.mergeTraceContext(
              traceId,
              teamId,
              { tags: trace.tags, metadata: trace.metadata, sessionId: trace.sessionId },
              tx,
            );
          }
        } else {
          const created = await this.spans.createTrace(
            {
              id: trace.traceId,
              teamId,
              sessionId: trace.sessionId ?? null,
              name: trace.name?.trim() || startedAt.toISOString(),
              tags: trace.tags,
              metadata: trace.metadata,
              startedAt,
            },
            tx,
          );
          traceId = created.id;
        }
      } else {
        const created = await this.spans.createTrace(
          {
            teamId,
            sessionId: trace.sessionId ?? null,
            name: trace.name?.trim() || startedAt.toISOString(),
            tags: trace.tags,
            metadata: trace.metadata,
            startedAt,
          },
          tx,
        );
        traceId = created.id;
      }

      // ── Validate parent references (batch spanIds ∪ already-stored refs) ──
      // Skipped entirely for callers that legitimately receive children first
      // (the OTLP receiver) — the ref is stored as-is and the tree heals later.
      if (!mode.allowUnknownParents) {
        const known = new Set<string>(trace.spans.map((s) => s.spanId));
        for (const ref of await this.spans.listSpanRefs(traceId, tx)) known.add(ref);
        for (const s of trace.spans) {
          if (s.parentSpanId && !known.has(s.parentSpanId)) {
            throw new AppError(
              `parentSpanId "${s.parentSpanId}" does not reference a known span in this trace.`,
              400,
              'INVALID_SPAN_PARENT',
            );
          }
        }
      }

      // ── Append spans, writing payloads only when capture is on ───────────
      for (const s of trace.spans) {
        const spanRow = mode.idempotent
          ? await this.spans.upsertSpan(this.toSpanInput(teamId, traceId, s), tx)
          : await this.spans.appendSpan(this.toSpanInput(teamId, traceId, s), tx);
        if (capture && (s.input !== undefined || s.output !== undefined || s.variables !== undefined)) {
          await this.spans.writePayload(
            spanRow.id,
            teamId,
            { input: s.input, output: s.output, variables: s.variables },
            tx,
          );
        }
      }

      return traceId;
    });
  }

  /** Earliest span startTime in the trace — the created trace's `startedAt`. */
  private earliestStart(spans: IngestSpan[]): Date {
    return spans
      .map((s) => new Date(s.startTime))
      .reduce((min, d) => (d.getTime() < min.getTime() ? d : min));
  }

  /** Maps an OTel-shaped IngestSpan onto T1's `CreateSpanInput`. */
  private toSpanInput(teamId: string, traceId: string, s: IngestSpan): CreateSpanInput {
    const startedAt = new Date(s.startTime);
    const endedAt = s.endTime ? new Date(s.endTime) : null;
    return {
      teamId,
      traceId,
      spanRef: s.spanId,
      parentSpanRef: s.parentSpanId ?? null,
      kind: s.kind ?? 'other',
      name: s.name,
      status: s.status ?? 'unset',
      startedAt,
      endedAt,
      latencyMs: endedAt ? Math.round(endedAt.getTime() - startedAt.getTime()) : null,
      model: s.model ?? null,
      provider: s.provider ?? null,
      promptTokens: s.usage?.promptTokens ?? null,
      completionTokens: s.usage?.completionTokens ?? null,
      totalTokens: s.usage?.totalTokens ?? null,
      costUsd: s.costUsd ?? null,
      promptVersionId: s.promptVersionId ?? null,
      gatewayRequestId: null, // SDK-reported spans have no gateway ledger row
      errorMessage: s.error ?? null,
      attributes: s.attributes ?? {},
    };
  }
}
