import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../shared/db/unit-of-work';
import { SpansRepository } from '../spans/spans.repository';
import { TraceSettingsRepository } from '../settings/settings.repository';
import { shouldCapture } from '../settings/should-capture';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import { enqueueOnlineEval } from '../../evaluations/online/enqueue-online-eval';
import type {
  GatewayCallContext,
  GatewayCompletionRequest,
  GatewayResult,
} from '../../gateway/completions/completions.types';
import type { SpanStatus } from '../../shared/db/schema';
import { buildFailureAttributes } from '../spans/span-failure';
import type { ChatMessage } from '../../gateway/providers/types';

const spansRepo = new SpansRepository();
const settingsRepo = new TraceSettingsRepository();
const gatewayRepo = new GatewayRepository();

/** Max length of the derived trace-input preview; long messages are truncated with an ellipsis. */
const TRACE_INPUT_PREVIEW_MAX = 120;

/**
 * Derives a human-readable trace name from the request's last `user` message —
 * used as the default trace name so the trace list reads by input (e.g. "city
 * name lahore") instead of an opaque timestamp. By the time this hook runs the
 * pipeline has already replaced `req.messages` with the RENDERED messages (see
 * gateway.service.ts), so a stored-prompt call yields its resolved text here.
 * Returns null when there is no user message with text (caller falls back to
 * the timestamp).
 */
function deriveTraceInputName(messages: ChatMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = m.role === 'user' ? m.content?.trim() : undefined;
    if (text) {
      return text.length > TRACE_INPUT_PREVIEW_MAX ? `${text.slice(0, TRACE_INPUT_PREVIEW_MAX)}…` : text;
    }
  }
  return null;
}

/**
 * Lifts the retry/fallback history off a ledger row's `meta` and onto span attributes.
 *
 * `callWithFallback` has always written `{ attempts, trail }` to `gateway_requests.meta`
 * on both the success and the failure path, and until issue #452 absolutely nothing read
 * it — not the span, not the usage API, not any page. So a request that succeeded only on
 * its third attempt, or that failed over to a different deployment, looked identical to a
 * clean first-try call. Copying it onto the span is what makes it visible.
 *
 * @param meta - The ledger row's `meta` column (Prisma `JsonValue`).
 * @returns `{ attempts, trail }` when present, otherwise an empty object to spread.
 */
function retryAttributes(meta: unknown): Record<string, unknown> {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const m = meta as { attempts?: unknown; trail?: unknown };
  const out: Record<string, unknown> = {};
  if (typeof m.attempts === 'number') out.attempts = m.attempts;
  if (Array.isArray(m.trail)) out.trail = m.trail;
  return out;
}

/** One entry of `gateway_requests.meta.trail`, as `callWithFallback` writes it. */
interface TrailEntry {
  model?: string;
  attempts?: number;
  error?: string;
}

/**
 * Builds the warning for a call the gateway had to rescue — one that only answered
 * because a model was called again, or because a different model was called instead.
 *
 * Such a call is a success, so its span is `ok` and its dot is green, and until now that
 * made it identical to a clean first-try call. A primary model that fails on every single
 * request is therefore invisible for as long as its fallback keeps answering: the bill
 * changes, the served model changes, and nothing in the trace list says so. A warning is
 * the right shape for this because it marks the span without claiming the request failed —
 * the same treatment issue #452 gave a tool whose 200 was really an error.
 *
 * @param meta - The ledger row's `meta` column.
 * @returns `{ warning }` to spread onto the span's attributes, or an empty object when the
 *   call was answered first time by the model that was asked for.
 */
function rescueWarning(meta: unknown): Record<string, unknown> {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const trail = (meta as { trail?: unknown }).trail;
  if (!Array.isArray(trail) || trail.length === 0) return {};

  const entries = trail as TrailEntry[];
  const retries = entries.reduce((sum, e) => sum + Math.max(0, (e.attempts ?? 1) - 1), 0);
  const first = entries[0];
  const last = entries[entries.length - 1];

  if (entries.length > 1) {
    const asked = first.model ?? 'the model asked for';
    const served = last.model ?? 'another model';
    const because = first.error ? `failed ${first.error}` : 'did not answer';
    return {
      warning: {
        type: 'model_fallback',
        message: `${asked} ${because}, so ${served} answered instead.`,
      },
    };
  }

  if (retries > 0) {
    const name = first.model ?? 'The model';
    return {
      warning: {
        type: 'provider_retry',
        message: `${name} answered only on attempt ${(first.attempts ?? retries + 1).toString()}.`,
      },
    };
  }

  return {};
}

/**
 * Turns a committed gateway completion into one `llm` span (FAQ Q1/Q2). Runs
 * AFTER the Phase 2 money `$transaction` has committed and is passed the already-
 * committed `gatewayRequestId` (NOT a transaction client) — it owns its OWN
 * `$transaction` so trace + span + payload + rollup are consistent with each other.
 *
 * Best-effort (FAQ Q6): the whole body is wrapped in try/catch; on any error it
 * logs and returns — it MUST NOT rethrow. Because it runs post-commit, a failure
 * here can never roll back the money row; swallowing simply leaves the already-sent
 * response untouched (mirrors the `await audit(...)` pattern).
 *
 * @param args.ctx - The call context, widened with T1 trace fields (traceId,
 *   parentSpanRef, sessionId, capturePayloads), T8 fields (traceName, traceTags,
 *   traceMetadata), and T9 fields (spanName, spanTags, spanMetadata).
 * @param args.result - The GatewayResult returned to the caller (used for the
 *   response body payload + fallback model/provider).
 * @param args.request - The pipeline request (used for the input-messages payload).
 * @param args.gatewayRequestId - The id of the committed gateway_requests ledger row.
 * @param args.promptVariables - Raw prompt variables for a prompt-ref call (null for
 *   raw-message calls); stored only when capture is on.
 * @param args.spanRef - Pre-minted span ref to use instead of generating one. The
 *   streaming path needs this: its response headers must be flushed before the first
 *   chunk, but the span is only written once the stream ends, so the id has to exist
 *   before there is anything to write.
 * @returns The resolved `{ traceId, spanRef }` of the trace this span landed in and
 *   the span's own opaque ref — so the caller can surface them as response headers
 *   and let a client-side tool loop nest its own spans under the same trace. Returns
 *   `undefined` when nothing was written (ledger row missing, or the best-effort
 *   write threw and was swallowed).
 */
export async function recordGatewaySpan(args: {
  ctx: GatewayCallContext;
  result: GatewayResult;
  request: GatewayCompletionRequest;
  gatewayRequestId: string;
  promptVariables?: Record<string, unknown> | null;
  spanRef?: string;
}): Promise<{ traceId: string; spanRef: string; spanId: string } | undefined> {
  const { ctx, result, request, gatewayRequestId, promptVariables } = args;
  try {
    const written = await runInTransaction(async (tx) => {
      const reqRow = await gatewayRepo.findById(gatewayRequestId, tx);
      if (!reqRow) return undefined; // nothing to mirror — ledger row not found

      // Reconstruct timings from the ledger row (createdAt = end; back off latency).
      const endedAt = reqRow.createdAt;
      const startedAt = new Date(reqRow.createdAt.getTime() - (reqRow.latencyMs ?? 0));
      const spanStatus: SpanStatus = reqRow.status === 'error' ? 'error' : 'ok';

      // Resolve the trace: nest under a caller-supplied trace if it exists for this
      // team; otherwise mint one (honoring the caller's trace id when provided).
      let trace = ctx.traceId ? await spansRepo.findTrace(ctx.traceId, ctx.teamId, tx) : null;
      if (!trace) {
        trace = await spansRepo.createTrace(
          {
            id: ctx.traceId,
            teamId: ctx.teamId,
            sessionId: ctx.sessionId ?? null,
            // Precedence on create: the caller's instruction, then a client library's
            // default, then the request's own text, then the Q12 timestamp.
            name:
              ctx.traceName?.trim() ||
              ctx.traceNameIfUnset?.trim() ||
              deriveTraceInputName(request.messages) ||
              startedAt.toISOString(),
            tags: ctx.traceTags,
            metadata: ctx.traceMetadata,
            status: 'unset',
            startedAt,
          },
          tx,
        );
      } else if (
        ctx.traceName?.trim() ||
        ctx.traceNameIfUnset?.trim() ||
        ctx.traceTags?.length ||
        ctx.traceMetadata
      ) {
        // `name` overwrites (Q11); `nameIfPlaceholder` only fills in a trace still
        // carrying the Q12 timestamp, so joining cannot rename (Q33).
        await spansRepo.mergeTraceContext(
          trace.id,
          ctx.teamId,
          {
            name: ctx.traceName?.trim(),
            nameIfPlaceholder: ctx.traceNameIfUnset?.trim(),
            tags: ctx.traceTags,
            metadata: ctx.traceMetadata,
          },
          tx,
        );
      }

      const spanRef = args.spanRef ?? randomUUID();
      const span = await spansRepo.appendSpan(
        {
          teamId: ctx.teamId,
          traceId: trace.id,
          spanRef,
          parentSpanRef: ctx.parentSpanRef ?? null,
          kind: 'llm',
          name: ctx.spanName?.trim() || startedAt.toISOString(),
          status: spanStatus,
          startedAt,
          endedAt,
          latencyMs: reqRow.latencyMs,
          model: reqRow.resolvedModel ?? result.model,
          provider: reqRow.provider ?? result.provider,
          promptTokens: reqRow.promptTokens,
          completionTokens: reqRow.completionTokens,
          totalTokens: reqRow.totalTokens,
          costUsd: reqRow.costUsd == null ? null : reqRow.costUsd.toNumber(),
          promptVersionId: reqRow.promptVersionId,
          gatewayRequestId: reqRow.id,
          errorMessage: reqRow.errorCode,
          attributes: {
            cacheHit: result.cacheHit,
            ...retryAttributes(reqRow.meta),
            // Only on a green span: a red one already says the call failed, and a
            // warning beside that would compete with the error rather than add to it.
            ...(spanStatus === 'ok' ? rescueWarning(reqRow.meta) : {}),
          },
          tags: ctx.spanTags,
          metadata: ctx.spanMetadata,
        },
        tx,
      );

      const teamSettings = await settingsRepo.get(ctx.teamId, tx);
      if (shouldCapture(teamSettings?.capturePayloads ?? true, ctx.capturePayloads)) {
        await spansRepo.writePayload(
          span.id,
          ctx.teamId,
          { input: request.messages, output: result.body, variables: promptVariables ?? null },
          tx,
        );
      }

      return { traceId: trace.id, spanRef, spanId: span.id };
    });

    if (written) {
      enqueueOnlineEval({ teamId: ctx.teamId, traceId: written.traceId, spanId: written.spanId, spanKind: 'llm' });
    }
    return written;
  } catch (err) {
    console.error('[trace] span write failed', err);
    return undefined;
  }
}

/**
 * Writes a red `llm` span for a model round that failed after every retry and fallback
 * was spent — the second half of issue #452.
 *
 * Until this existed, a failed round produced a `gateway_requests` row with
 * `status: 'error'` and then threw, and {@link recordGatewaySpan} was only ever called
 * from the three success paths. The result was that the usage page counted a failure the
 * trace view could not show, for the same request. In a multi-round agent loop the effect
 * was worse: the rounds that succeeded were in the trace, the round that broke the run
 * was not, so the trace ended early with no explanation.
 *
 * It is a separate entry point rather than a branch inside {@link recordGatewaySpan}
 * because the success hook is built around a `GatewayResult` — the response body, model,
 * provider and cache flag — and a failed round has none of those. Faking one so a shared
 * function could be reused would put invented values into the span.
 *
 * Best-effort on exactly the same terms as its sibling: it runs after the ledger row has
 * committed, wraps everything in try/catch, and never rethrows, so a tracing problem can
 * never turn one failure into two. It also does NOT enqueue an online evaluation — there
 * is no output to judge.
 *
 * @param args.ctx - The call context, with its trace fields.
 * @param args.request - The pipeline request, for the input-messages payload.
 * @param args.gatewayRequestId - Id of the committed error row in `gateway_requests`.
 * @param args.spanRef - Pre-minted span ref (the streaming path mints one up front).
 * @returns The `{ traceId, spanRef }` the span landed on, or `undefined` when nothing
 *   was written (ledger row missing, or the best-effort write threw and was swallowed).
 */
export async function recordGatewayErrorSpan(args: {
  ctx: GatewayCallContext;
  request: GatewayCompletionRequest;
  gatewayRequestId: string;
  spanRef?: string;
}): Promise<{ traceId: string; spanRef: string } | undefined> {
  const { ctx, request, gatewayRequestId } = args;
  try {
    return await runInTransaction(async (tx) => {
      const reqRow = await gatewayRepo.findById(gatewayRequestId, tx);
      if (!reqRow) return undefined;

      const endedAt = reqRow.createdAt;
      const startedAt = new Date(reqRow.createdAt.getTime() - (reqRow.latencyMs ?? 0));

      // Same trace resolution as the success hook: nest under the caller's trace when it
      // exists for this team, otherwise mint one honoring their id. A failed round must
      // land in the SAME trace as the rounds around it, or the loop reads as two traces.
      let trace = ctx.traceId ? await spansRepo.findTrace(ctx.traceId, ctx.teamId, tx) : null;
      if (!trace) {
        trace = await spansRepo.createTrace(
          {
            id: ctx.traceId,
            teamId: ctx.teamId,
            sessionId: ctx.sessionId ?? null,
            name:
              ctx.traceName?.trim() ||
              ctx.traceNameIfUnset?.trim() ||
              deriveTraceInputName(request.messages) ||
              startedAt.toISOString(),
            tags: ctx.traceTags,
            metadata: ctx.traceMetadata,
            status: 'unset',
            startedAt,
          },
          tx,
        );
      }

      const errorCode = reqRow.errorCode ?? 'PROVIDER_ERROR';
      const { attributes, status, errorMessage } = buildFailureAttributes(
        retryAttributes(reqRow.meta),
        { errorType: 'provider_error', message: errorCode, fatal: true },
      );

      const spanRef = args.spanRef ?? randomUUID();
      const span = await spansRepo.appendSpan(
        {
          teamId: ctx.teamId,
          traceId: trace.id,
          spanRef,
          parentSpanRef: ctx.parentSpanRef ?? null,
          kind: 'llm',
          name: ctx.spanName?.trim() || startedAt.toISOString(),
          status: status as SpanStatus,
          startedAt,
          endedAt,
          latencyMs: reqRow.latencyMs,
          model: reqRow.resolvedModel ?? reqRow.requestedModel,
          provider: reqRow.provider,
          promptVersionId: reqRow.promptVersionId,
          gatewayRequestId: reqRow.id,
          errorMessage,
          attributes,
          tags: ctx.spanTags,
          metadata: ctx.spanMetadata,
        },
        tx,
      );

      const teamSettings = await settingsRepo.get(ctx.teamId, tx);
      if (shouldCapture(teamSettings?.capturePayloads ?? true, ctx.capturePayloads)) {
        // The input is the whole value of a failed round's payload: it is the only way to
        // see WHAT was being asked when the provider gave up.
        await spansRepo.writePayload(
          span.id,
          ctx.teamId,
          { input: request.messages, output: { error: errorCode }, variables: null },
          tx,
        );
      }

      return { traceId: trace.id, spanRef };
    });
  } catch (err) {
    console.error('[trace] error span write failed', err);
    return undefined;
  }
}
