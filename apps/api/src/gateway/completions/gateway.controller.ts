import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { GatewayService } from './gateway.service';
import { ChatCompletionRequestSchema, SpanContextBodySchema, TraceContextBodySchema } from './completions.types';
import type {
  GatewayCallContext,
  GatewayCompletionRequest,
  SpanContextBody,
  TraceContextBody,
} from './completions.types';
import { ProviderError } from '../providers/adapter';
import { ValidationError, RateLimitedError, ProviderRateLimitedError } from '../../shared/errors';

/**
 * Validates one optional context object from the request body, field by field.
 *
 * Whole-object `safeParse` is wrong here. This is decoration on a call the
 * caller is paying for, so one mistyped field must not discard the other five,
 * and a malformed object must never fail the completion — refusing a paid
 * completion over a tracing detail is worse than the problem. But ignoring it
 * in silence is what made #511 invisible: the bad value reached Prisma inside a
 * best-effort trace write, threw there, and the call came back 200 with no
 * trace and nothing said.
 *
 * So each key is parsed on its own. What parses is kept; what does not is
 * dropped and its name collected, and the caller is told in a response header
 * which fields were ignored.
 *
 * @param schema - The partial object schema for this context object.
 * @param raw - The value read off `req.body`, of unknown shape.
 * @param prefix - `'trace'` or `'span'`, used to name a dropped field.
 * @param dropped - Collects the dotted names of fields that did not parse.
 * @returns The fields that parsed, with no key for any that did not.
 */
function readContextObject<T extends z.ZodRawShape>(
  schema: z.ZodObject<T, 'strip', z.ZodTypeAny, Record<string, unknown>>,
  raw: unknown,
  prefix: string,
  dropped: string[],
): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  // An array is an object to `typeof`, and neither it nor a scalar can carry
  // named fields — so the whole thing goes, under its own name.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    dropped.push(prefix);
    return {};
  }

  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    if (!(key in source) || source[key] === undefined) continue;
    const parsed = (fieldSchema as z.ZodTypeAny).safeParse(source[key]);
    if (parsed.success) out[key] = parsed.data;
    else dropped.push(`${prefix}.${key}`);
  }
  return out;
}

/**
 * Reads a `x-<prefix>-tags` (comma-separated, trimmed, empties dropped) header,
 * falling back to the body's `tags` array when the header is absent.
 */
function readTagsHeader(req: Request, header: string, bodyTags: string[] | undefined): string[] | undefined {
  const raw = req.header(header);
  if (!raw) return bodyTags;
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Reads a `x-<prefix>-metadata` JSON-object-string header, falling back to the
 * body's `metadata` object when the header is absent or unusable. Never a 400 —
 * this endpoint spends money and a tracing detail must not fail the call.
 *
 * "Unusable" now covers valid JSON of the wrong shape, not only a parse error.
 * `JSON.parse('"hi"')` and `JSON.parse('[1]')` both succeed and both used to be
 * cast to `Record<string, unknown>` and written to the trace, so the header
 * could put a string or an array in a column every reader treats as an object.
 *
 * @param req - The Express request.
 * @param header - The header name to read.
 * @param bodyMetadata - The already-validated body fallback.
 * @param dropped - Collects the header's name when it was present and unusable.
 */
function readMetadataHeader(
  req: Request,
  header: string,
  bodyMetadata: Record<string, unknown> | undefined,
  dropped: string[],
): Record<string, unknown> | undefined {
  const raw = req.header(header);
  if (!raw) return bodyMetadata;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    dropped.push(header);
    return bodyMetadata;
  }
  const checked = z.record(z.unknown()).safeParse(parsed);
  if (!checked.success) {
    dropped.push(header);
    return bodyMetadata;
  }
  return checked.data;
}

/**
 * Reads the optional T1 trace context and T9 span context from headers (primary)
 * and the body `trace`/`span` objects (fallback). A header always wins over the
 * matching body field. An empty header string is treated as absent.
 * `x-capture-payloads` accepts only the exact strings `'true'` / `'false'`;
 * anything else is ignored (falls back to body).
 *
 * @param req - The Express request (headers + body).
 * @param bodyTrace - The validated `trace` object from `req.body`.
 * @param bodySpan - The validated `span` object from `req.body`.
 * @param dropped - Collects the name of any header that was present and unusable.
 * @returns The trace/span context fields to merge into GatewayCallContext.
 */
function readTracingContext(
  req: Request,
  bodyTrace: TraceContextBody | undefined,
  bodySpan: SpanContextBody | undefined,
  dropped: string[],
): {
  traceId?: string;
  parentSpanRef?: string;
  sessionId?: string;
  capturePayloads?: boolean;
  traceName?: string;
  traceNameIfUnset?: string;
  traceTags?: string[];
  traceMetadata?: Record<string, unknown>;
  spanName?: string;
  spanTags?: string[];
  spanMetadata?: Record<string, unknown>;
} {
  const h = (name: string): string | undefined => {
    const v = req.header(name);
    return v && v.length > 0 ? v : undefined;
  };
  // The trace name is sent percent-encoded (header values must be ISO-8859-1,
  // but the name is free text and may contain any Unicode). Decode it back;
  // fall back to the raw value if it wasn't encoded (older clients) or is
  // malformed, so decoding can never fail the request.
  const decodedHeader = (name: string): string | undefined => {
    const v = h(name);
    if (v === undefined) return undefined;
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const captureHeader = ((): boolean | undefined => {
    const v = req.header('x-capture-payloads');
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  })();

  return {
    traceId: h('x-trace-id') ?? bodyTrace?.traceId,
    parentSpanRef: h('x-parent-span-id') ?? bodyTrace?.parentSpanId,
    sessionId: h('x-session-id') ?? bodyTrace?.sessionId,
    capturePayloads: captureHeader ?? bodyTrace?.capturePayloads,
    traceName: decodedHeader('x-trace-name') ?? bodyTrace?.name,
    traceNameIfUnset: decodedHeader('x-trace-name-if-unset') ?? bodyTrace?.nameIfUnset,
    traceTags: readTagsHeader(req, 'x-trace-tags', bodyTrace?.tags),
    traceMetadata: readMetadataHeader(req, 'x-trace-metadata', bodyTrace?.metadata, dropped),
    spanName: h('x-span-name') ?? bodySpan?.name,
    spanTags: readTagsHeader(req, 'x-span-tags', bodySpan?.tags),
    spanMetadata: readMetadataHeader(req, 'x-span-metadata', bodySpan?.metadata, dropped),
  };
}

/**
 * HTTP boundary for the gateway completion endpoint. Validates the OpenAI-shaped
 * body, builds the call context from the authenticated session / API key, invokes
 * the service, and sets the gateway metadata headers (FAQ Q4).
 */
export class GatewayController {
  constructor(private readonly service: GatewayService) {}

  /**
   * POST /api/v1/gateway/chat/completions
   * Auth (router): gatewayAuth — virtual key (primary) or session/personal key
   * (fallback, owner/admin/editor). The middleware always sets `req.gateway`.
   * @throws {ValidationError} 400 on a bad body/params.
   */
  chatCompletion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ChatCompletionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid request');
      }

      // req.gateway is always set by gatewayAuth (virtual-key or session path).
      const noStore = req.header('x-gateway-cache') === 'no-store';

      // T1/T9: merge trace + span context (headers win over body `trace`/`span`)
      // into the ctx. `ChatCompletionRequestSchema` strips unknown keys, so these are
      // read off the raw body and validated here rather than in `parsed.data`.
      const dropped: string[] = [];
      const bodyTrace = readContextObject(
        TraceContextBodySchema,
        req.body?.trace,
        'trace',
        dropped,
      ) as TraceContextBody;
      const bodySpan = readContextObject(
        SpanContextBodySchema,
        req.body?.span,
        'span',
        dropped,
      ) as SpanContextBody;
      const ctx: GatewayCallContext = {
        ...req.gateway!,
        ...readTracingContext(req, bodyTrace, bodySpan, dropped),
      };
      // Say what was ignored rather than only dropping it. A wrong type here used to
      // throw inside the best-effort trace write, so the call came back 200, billed,
      // with no trace and nothing to explain where it went (#511). Failing the call
      // instead would be worse, so the answer is a header the caller can read.
      if (dropped.length > 0) res.setHeader('x-gateway-context-ignored', dropped.join(','));

      // Streaming branch: serve Server-Sent Events. completeStream throws BEFORE
      // headers are sent for any pre-first-chunk failure, so those surface as JSON
      // errors via the outer catch below.
      if (parsed.data.stream === true) {
        await this.handleStream(ctx, parsed.data, res);
        return;
      }

      const result = await this.service.complete(ctx, parsed.data, { noStore });

      res.setHeader('x-gateway-request-id', result.requestId);
      res.setHeader('x-gateway-provider', result.provider);
      res.setHeader('x-gateway-model', result.model);
      res.setHeader('x-gateway-cost-usd', result.costUsd === null ? '' : String(result.costUsd));
      res.setHeader('x-gateway-cache', result.cacheHit ? 'hit' : 'miss');
      // T1: expose the trace this call's span landed in + the span's own ref, so a
      // client-side tool loop can thread every span into one trace and nest its
      // tool spans under this llm span (undefined when the best-effort write no-op'd).
      if (result.traceId) res.setHeader('x-gateway-trace-id', result.traceId);
      if (result.spanRef) res.setHeader('x-gateway-span-id', result.spanRef);
      if (result.rateLimitRemaining !== undefined) {
        res.setHeader('x-gateway-ratelimit-remaining', String(result.rateLimitRemaining));
      }

      res.status(200).json(result.body);
    } catch (err) {
      // Surface Retry-After for rate limits — ours (populated by G4) and the
      // upstream provider's, forwarded verbatim from its own 429 response.
      if (
        (err instanceof RateLimitedError || err instanceof ProviderRateLimitedError) &&
        err.retryAfter !== undefined
      ) {
        res.setHeader('Retry-After', String(err.retryAfter));
      }
      next(err);
    }
  };

  /**
   * Drive a streaming completion end to end: open the provider stream (pre-first-
   * chunk errors propagate as normal JSON via the outer catch), flush SSE headers,
   * write OpenAI `chat.completion.chunk` frames, terminate with `[DONE]`, and
   * finalize the request row. Handles mid-stream provider errors and client abort.
   *
   * @param ctx - The resolved gateway call context.
   * @param body - The validated streaming request.
   * @param res - The Express response (headers not yet sent when called).
   * @throws Any pre-first-chunk pipeline error (budget/rate/scope/provider) — the
   *   outer controller catch maps it to a JSON error since no bytes were written.
   */
  private handleStream = async (
    ctx: GatewayCallContext,
    body: GatewayCompletionRequest,
    res: Response,
  ): Promise<void> => {
    // completeStream throws BEFORE headers are sent for any pre-first-chunk
    // failure (402/429/400/502) → caught by the outer handler → JSON error.
    const gs = await this.service.completeStream(ctx, body);

    let clientAborted = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientAborted = true;
        gs.abort(); // tear down the upstream provider stream
      }
    });

    // First chunk is buffered inside gs.chunks — safe to flush headers now.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('x-gateway-request-id', gs.requestId);
    res.setHeader('x-gateway-provider', gs.provider);
    res.setHeader('x-gateway-model', gs.resolvedModel);
    // x-gateway-cost-usd is intentionally omitted for streams (cost not yet known).
    // The trace/span ids ARE known: they are minted up front precisely so a client
    // tool loop can nest its own spans under a streamed turn (see GatewayStream).
    res.setHeader('x-gateway-trace-id', gs.traceId);
    res.setHeader('x-gateway-span-id', gs.spanRef);
    res.flushHeaders();

    const id = `chatcmpl-${gs.requestId}`;
    const created = Math.floor(Date.now() / 1000);
    let streamErrored = false;
    let errorCode: string | undefined;

    try {
      for await (const chunk of gs.chunks) {
        if (clientAborted) break;
        // TC2 Task 5: forward tool-call deltas alongside content deltas so a
        // streaming caller can assemble tool_calls the same way it assembles text.
        const delta: Record<string, unknown> = {};
        if (chunk.delta) delta['content'] = chunk.delta;
        if (chunk.tool_calls) delta['tool_calls'] = chunk.tool_calls;
        const frame = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: gs.resolvedModel,
          choices: [{ index: 0, delta, finish_reason: chunk.finish_reason }],
        };
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    } catch (err) {
      // Client abort tears the stream down cleanly (no error frame). A genuine
      // provider failure AFTER the first chunk cannot change the HTTP status
      // (headers already sent), so emit a terminal error frame instead.
      if (!clientAborted) {
        streamErrored = true;
        errorCode = err instanceof ProviderError ? 'PROVIDER_ERROR' : 'STREAM_ERROR';
        if (!res.writableEnded) {
          const message = err instanceof Error ? err.message : 'Stream failed.';
          res.write(`data: ${JSON.stringify({ error: { code: errorCode, message } })}\n\n`);
        }
      }
    }

    // Persist row + budget increment exactly once, BEFORE signaling stream end,
    // so the gateway_requests row is durable by the time the client sees `[DONE]`.
    await gs.finalize({
      status: streamErrored ? 'error' : 'success',
      errorCode,
      clientAborted,
    });

    if (!clientAborted && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (!res.writableEnded) {
      res.end();
    }
  };
}
