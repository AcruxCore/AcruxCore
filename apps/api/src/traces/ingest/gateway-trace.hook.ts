import { randomUUID } from 'node:crypto';
import { runInTransaction } from '../../shared/db/unit-of-work';
import { SpansRepository } from '../spans/spans.repository';
import { TraceSettingsRepository } from '../settings/settings.repository';
import { shouldCapture } from '../settings/should-capture';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import type {
  GatewayCallContext,
  GatewayCompletionRequest,
  GatewayResult,
} from '../../gateway/completions/completions.types';
import type { SpanStatus } from '../../shared/db/schema';
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
}): Promise<{ traceId: string; spanRef: string } | undefined> {
  const { ctx, result, request, gatewayRequestId, promptVariables } = args;
  try {
    return await runInTransaction(async (tx) => {
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
            name: ctx.traceName?.trim() || deriveTraceInputName(request.messages) || startedAt.toISOString(),
            tags: ctx.traceTags,
            metadata: ctx.traceMetadata,
            status: 'unset',
            startedAt,
          },
          tx,
        );
      } else if (ctx.traceName?.trim() || ctx.traceTags?.length || ctx.traceMetadata) {
        await spansRepo.mergeTraceContext(
          trace.id,
          ctx.teamId,
          { name: ctx.traceName?.trim(), tags: ctx.traceTags, metadata: ctx.traceMetadata },
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
          attributes: { cacheHit: result.cacheHit },
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

      return { traceId: trace.id, spanRef };
    });
  } catch (err) {
    console.error('[trace] span write failed', err);
    return undefined;
  }
}
