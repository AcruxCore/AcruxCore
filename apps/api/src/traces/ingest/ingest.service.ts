import { runInTransaction } from '../../shared/db/unit-of-work';
import { SpansRepository } from '../spans';
import type { CreateSpanInput } from '../spans';
import { TraceSettingsRepository, shouldCapture } from '../settings';
import { AppError, NotFoundError, PayloadTooLargeError } from '../../shared/errors';
import { enqueueOnlineEval } from '../../evaluations/online/enqueue-online-eval';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import type { IngestSpan, IngestTrace, IngestResponse } from './ingest.types';
import { SpanPricer } from './span-pricer';
import { INT4_MAX } from './int4-range';

/** Maximum spans accepted in one ingestion request (Phase-3 guard, FAQ / spec). */
const MAX_SPANS_PER_BATCH = 200;

/**
 * The trace name a report states as its root step's, or `undefined`.
 *
 * Both SDKs' `traces.step` send the outermost step's report with `name` equal to the
 * root span's own name. That pairing is what makes it a step naming its trace rather
 * than a report that merely joins one: a BYO `chat()` report also carries a `name`
 * (often the `'chat'` default), but its span is named after the model. Only this pairing
 * may replace a name the server derived (FAQ Q48, issue #791).
 */
function rootStepName(trace: IngestTrace): string | undefined {
  const name = trace.name?.trim();
  if (!name) return undefined;
  return trace.spans.some((s) => !s.parentSpanId && s.name.trim() === name) ? name : undefined;
}

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

  /** Prices spans that arrive without a cost: team model price first, registry second. */
  private readonly pricer = new SpanPricer();

  /**
   * Validates and persists a batch of traces for a team.
   *
   * @param teamId - Team scope from the authenticated principal.
   * @param traces - The validated batch (Zod-parsed at the controller boundary).
   * @param opts - Optional flags.
   *        `idempotent` — when true, retried batches with the same spanIds are
   *        safe: a span already stored is updated, not inserted again. Both the
   *        OTLP receiver and `POST /traces` set it, because both have senders that
   *        retry; false keeps the stricter create-and-fail behavior.
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
   * @throws {NotFoundError} 404 if a span's promptVersionId belongs to another
   *         team. A supplied traceId never fails this way: it names a trace within
   *         the calling team only.
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
    const pricedTraces = await this.pricer.price(teamId, traces);

    // Team-level capture default is resolved once; each trace may override it.
    const teamSetting = (await this.settings.get(teamId))?.capturePayloads ?? true;

    const traceIds: string[] = [];
    for (const trace of pricedTraces) {
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
   * Ingests each trace on its own, for a caller that must store the good traces of a batch
   * even when one is refused (the OTLP receiver). Each trace keeps its own transaction, as
   * in {@link ingest}, but the team's capture setting and model prices are read once for
   * the whole batch rather than once per trace (issue #851).
   *
   * @param teamId - Team scope from the authenticated principal.
   * @param traces - The traces, each holding at most `MAX_SPANS_PER_BATCH` spans.
   * @param opts - As {@link ingest}.
   * @returns One entry per input trace, in order: the stored trace id, or the typed client
   *   error (an `AppError` below 500) that refused it. Nothing of a refused trace is stored.
   * @throws The first error that is not a typed client error, after the traces before it
   *   are stored.
   */
  async ingestEach(
    teamId: string,
    traces: IngestTrace[],
    opts?: { idempotent?: boolean; allowUnknownParents?: boolean; derivedName?: boolean },
  ): Promise<Array<{ traceId: string } | { error: AppError }>> {
    const pricedTraces = await this.pricer.price(teamId, traces);
    const teamSetting = (await this.settings.get(teamId))?.capturePayloads ?? true;
    const mode = {
      idempotent: opts?.idempotent ?? false,
      allowUnknownParents: opts?.allowUnknownParents ?? false,
      derivedName: opts?.derivedName ?? false,
    };

    const results: Array<{ traceId: string } | { error: AppError }> = [];
    for (const trace of pricedTraces) {
      try {
        if (trace.spans.length > MAX_SPANS_PER_BATCH) {
          throw new PayloadTooLargeError(
            `Trace has ${trace.spans.length} spans; the per-trace limit is ${MAX_SPANS_PER_BATCH}.`,
          );
        }
        await this.assertPromptVersionsAreOurs(teamId, [trace]);
        results.push({ traceId: await this.ingestTrace(teamId, trace, teamSetting, mode) });
      } catch (err) {
        if (!(err instanceof AppError) || err.statusCode >= 500) throw err;
        results.push({ error: err });
      }
    }
    return results;
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
   *         404 rather than 403: a 403 would confirm that the id names a real
   *         version somewhere.
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
      const fresh = {
        teamId,
        sessionId: trace.sessionId ?? null,
        name: trace.name?.trim() || startedAt.toISOString(),
        nameIsDerived: mode.derivedName || !trace.name?.trim(),
        tags: trace.tags,
        metadata: trace.metadata,
        startedAt,
      };
      let traceId: string;
      if (trace.traceId) {
        // Insert-if-absent, not find-then-create: another writer may be opening the same
        // new trace at this moment (the OTLP exporter and the SDK span queue, say).
        const { trace: row, created } = await this.spans.createTraceIfAbsent(
          { ...fresh, id: trace.traceId },
          tx,
        );
        // Always this team's row: an id another team holds gets this team its own trace,
        // under a server-generated id, so never use `trace.traceId` past this point.
        traceId = row.id;
        if (!created) {
          // A derived name is offered rather than asserted. OTLP batches arrive in any
          // order, so the batch that creates a trace may not be the one holding its root
          // span — this is what lets a later batch replace the timestamp fallback, while
          // still never pushing a real name back to a timestamp (issue #362).
          const derivedName = mode.derivedName ? trace.name?.trim() : undefined;
          const rootName = mode.derivedName ? undefined : rootStepName(trace);
          await this.spans.mergeTraceContext(
            traceId,
            teamId,
            {
              tags: trace.tags,
              metadata: trace.metadata,
              sessionId: trace.sessionId,
              ...(derivedName ? { nameIfPlaceholder: derivedName } : {}),
              ...(rootName ? { nameIfDerived: rootName } : {}),
              // The call that opened the trace may have started after this batch's
              // spans did, such as a step's root span.
              startedAt,
            },
            tx,
          );
        }
      } else {
        traceId = (await this.spans.createTrace(fresh, tx)).id;
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
      // Only a span this call newly stores is scored. An idempotent re-send (an OTLP
      // exporter retry, or the same span repeated in one export) upserts the stored
      // row again, and queueing it again would buy one more paid judge call per copy
      // that a rule's daily limit, which counts distinct scored spans, never sees.
      // Only this batch's refs are looked up: reading every stored ref made each chunk of a
      // large OTLP trace cost as much as the whole trace so far.
      if (mode.idempotent) {
        // One statement for the spans and one for the payloads, however many spans the
        // trace has (issue #851). `inserted` is false for a span already stored.
        const stored = await this.spans.upsertSpans(
          traceId,
          trace.spans.map((s) => this.toSpanInput(teamId, traceId, s)),
          tx,
        );
        const idByRef = new Map(stored.map((r) => [r.spanRef, r.id]));
        for (const r of stored) if (r.kind === 'llm' && r.inserted) llmSpanIds.push(r.id);
        if (capture) {
          // A span repeated in the batch keeps the payload of its last copy that had one,
          // as the one-span-at-a-time writes did.
          const payloads = new Map<string, { spanId: string; input?: unknown; output?: unknown; variables?: unknown }>();
          for (const s of trace.spans) {
            if (s.input === undefined && s.output === undefined && s.variables === undefined) continue;
            const spanId = idByRef.get(s.spanId)!;
            payloads.set(spanId, { spanId, input: s.input, output: s.output, variables: s.variables });
          }
          await this.spans.writePayloads(teamId, [...payloads.values()], tx);
        }
        return traceId;
      }

      for (const s of trace.spans) {
        const spanRow = await this.spans.appendSpan(this.toSpanInput(teamId, traceId, s), tx);
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

    // A span repeated inside one batch is still one span: queue it once.
    for (const spanId of new Set(llmSpanIds)) {
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

  /**
   * Maps an OTel-shaped IngestSpan onto T1's `CreateSpanInput`.
   *
   * A latency past `INT4_MAX` ms (~24.8 days, so an end time that is wrong rather than a
   * slow span) is stored as unknown, and a derived total past it is capped, so the INT4
   * columns never refuse the span and fail its trace (issue #843).
   */
  private toSpanInput(teamId: string, traceId: string, s: IngestSpan): CreateSpanInput {
    const startedAt = new Date(s.startTime);
    const endedAt = s.endTime ? new Date(s.endTime) : null;
    const latencyMs = endedAt ? Math.round(endedAt.getTime() - startedAt.getTime()) : null;
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
      latencyMs: latencyMs !== null && latencyMs > INT4_MAX ? null : latencyMs,
      model: s.model ?? null,
      provider: s.provider ?? null,
      promptTokens: s.usage?.promptTokens ?? null,
      completionTokens: s.usage?.completionTokens ?? null,
      // Many clients send only prompt + completion; without this the span's tokens summed
      // as 0 in every analytics total and dashboard column.
      totalTokens:
        s.usage?.totalTokens ??
        (s.usage?.promptTokens !== undefined && s.usage?.completionTokens !== undefined
          ? Math.min(s.usage.promptTokens + s.usage.completionTokens, INT4_MAX)
          : null),
      cachedTokens: s.usage?.cachedTokens ?? null,
      costUsd: s.costUsd ?? null,
      promptVersionId: s.promptVersionId ?? null,
      gatewayRequestId: null, // SDK-reported spans have no gateway ledger row
      errorMessage: s.error ?? null,
      attributes: s.attributes ?? {},
    };
  }
}
