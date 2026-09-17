import { runInTransaction } from '../../shared/db/unit-of-work';
import { SpansRepository } from '../spans';
import type { CreateSpanInput } from '../spans';
import { TraceSettingsRepository, shouldCapture } from '../settings';
import { AppError, NotFoundError, PayloadTooLargeError } from '../../shared/errors';
import { enqueueOnlineEval } from '../../evaluations/online/enqueue-online-eval';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
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
   * Read-only lookup used to check that a client-supplied `promptVersionId`
   * belongs to the calling team. Held inline rather than injected, mirroring
   * `GatewayService`, which resolves the same client-supplied field the same way.
   */
  private readonly promptVersions = new VersionsRepository();

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
   * @throws {NotFoundError} 404 if a supplied traceId, or a span's
   *         promptVersionId, belongs to another team.
   * @throws {AppError} 400 `INVALID_SPAN_PARENT` if a parentSpanId resolves to
   *         nothing and `opts.allowUnknownParents` is not set.
   */
  async ingest(
    teamId: string,
    traces: IngestTrace[],
    opts?: { idempotent?: boolean; allowUnknownParents?: boolean; derivedName?: boolean },
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

    await this.assertPromptVersionsAreOurs(teamId, traces);

    // Team-level capture default is resolved once; each trace may override it.
    const teamSetting = (await this.settings.get(teamId))?.capturePayloads ?? true;

    const traceIds: string[] = [];
    for (const trace of traces) {
      traceIds.push(
        await this.ingestTrace(teamId, trace, teamSetting, {
          idempotent: opts?.idempotent ?? false,
          allowUnknownParents: opts?.allowUnknownParents ?? false,
          derivedName: opts?.derivedName ?? false,
        }),
      );
    }
    return { accepted: totalSpans, traceIds };
  }

  /**
   * Refuses a batch carrying a `promptVersionId` the team does not own.
   *
   * A span's prompt version is the one id in the batch that arrives in the body
   * and names an object outside the traces domain, so no route-level check ever
   * sees it. Left unchecked it is stored as given, and both grouped reads
   * (`/traces/analytics` and `/traces/feedback/summary`) resolve it to a prompt
   * name — which is how a foreign id became a way to read another team's prompt
   * name and id. The gateway has always refused the same field on its own path
   * (`resolveClientPromptVersionId`); this brings the SDK path in line.
   *
   * One query for the whole batch, however many spans or distinct versions it
   * names.
   *
   * @param teamId - Team scope from the authenticated principal.
   * @param traces - The validated batch.
   * @throws {NotFoundError} 404 if any id is not a prompt version of this team.
   *         404 rather than 403 for the same reason as the trace check above: a
   *         403 would confirm that the id names a real version somewhere.
   */
  private async assertPromptVersionsAreOurs(teamId: string, traces: IngestTrace[]): Promise<void> {
    const ids = new Set<string>();
    for (const trace of traces) {
      for (const span of trace.spans) {
        if (span.promptVersionId) ids.add(span.promptVersionId);
      }
    }
    if (ids.size === 0) return;
    const owned = await this.promptVersions.countByIdsForTeam([...ids], teamId);
    if (owned !== ids.size) {
      throw new NotFoundError('Prompt version not found.');
    }
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
   *        `derivedName`: `trace.name` was derived from the batch rather than
   *        supplied by the caller, so it fills in a placeholder name and never
   *        overwrites a real one — see {@link SpansRepository.mergeTraceContext}.
   * @returns The resolved trace id.
   */
  private async ingestTrace(
    teamId: string,
    trace: IngestTrace,
    teamSetting: boolean,
    mode: { idempotent: boolean; allowUnknownParents: boolean; derivedName: boolean },
  ): Promise<string> {
    const capture = shouldCapture(teamSetting, trace.capturePayloads);
    const startedAt = this.earliestStart(trace.spans);
    const llmSpanIds: string[] = [];

    const traceId = await runInTransaction(async (tx) => {
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
          // A derived name is offered rather than asserted. OTLP batches arrive in any
          // order, so the batch that creates a trace may not be the one holding its root
          // span — this is what lets a later batch replace the timestamp fallback, while
          // still never pushing a real name back to a timestamp (issue #362).
          const derivedName = mode.derivedName ? trace.name?.trim() : undefined;
          if (trace.tags?.length || trace.metadata || trace.sessionId || derivedName) {
            await this.spans.mergeTraceContext(
              traceId,
              teamId,
              {
                tags: trace.tags,
                metadata: trace.metadata,
                sessionId: trace.sessionId,
                ...(derivedName ? { nameIfPlaceholder: derivedName } : {}),
              },
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
        if (spanRow.kind === 'llm') llmSpanIds.push(spanRow.id);
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

    for (const spanId of llmSpanIds) {
      enqueueOnlineEval({ teamId, traceId, spanId, spanKind: 'llm' });
    }
    return traceId;
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
