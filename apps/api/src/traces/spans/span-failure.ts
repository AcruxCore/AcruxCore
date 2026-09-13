/**
 * The one vocabulary every failure classifier writes into `spans.attributes`.
 *
 * Two completely different code paths can record the same tool execution — the
 * platform's `http` executor (`tools/execute`) and a client-side tool running inside
 * an SDK loop — and a third records model rounds (the gateway). If each invented its
 * own attribute names, `error_type:` filters and the per-tool error rate on
 * `GET /tools/analytics` would silently count different things depending on who ran
 * the call. Hence one module, imported by all of them, and mirrored verbatim in both
 * published SDKs.
 */

/**
 * Why a span is red, ordered by how authoritative the signal is.
 *
 * - `transport` — the request never completed: DNS, connection, timeout, SSRF block,
 *   size cap. The transport itself knows.
 * - `http_status` — the call completed and the upstream said non-2xx. The protocol knows.
 * - `tool_declared` — the tool's owner said this was a failure, either by returning the
 *   SDK's error sentinel or through a catalog `failureWhen` predicate that fired. Only
 *   the owner can know that HTTP 200 with `{"error": ...}` is a failure.
 * - `schema_mismatch` — the result did not satisfy the tool's declared `resultSchema`.
 *   A warning by default (see {@link SpanWarning}); an error only when the tool opts in.
 * - `transform` — a `requestTransform`/`responseTransform` threw, timed out, or returned
 *   something that could not cross the isolate boundary.
 * - `provider_error` — a model round failed after every retry and fallback was spent.
 */
export type SpanErrorType =
  | 'transport'
  | 'http_status'
  | 'tool_declared'
  | 'schema_mismatch'
  | 'transform'
  | 'provider_error';

/** Every value {@link SpanErrorType} admits, for runtime validation of a filter value. */
export const SPAN_ERROR_TYPES: readonly SpanErrorType[] = [
  'transport',
  'http_status',
  'tool_declared',
  'schema_mismatch',
  'transform',
  'provider_error',
] as const;

/** Narrows an arbitrary string to a {@link SpanErrorType}. */
export function isSpanErrorType(value: string): value is SpanErrorType {
  return (SPAN_ERROR_TYPES as readonly string[]).includes(value);
}

/**
 * Something worth seeing that is not a verdict about whether the run failed.
 *
 * Deliberately NOT a fourth `span_status` value. A new enum member would need a
 * migration, and would break the binary trace rollup in `SpansRepository.appendSpan`
 * ("any span errored → the trace errored"), which would have to grow a precedence rule
 * for a state that, by definition, does not decide success or failure.
 *
 * `type` is a short stable slug the tool owner chooses (`stale_data`, `partial_result`);
 * `message` is free text for a human reading the span panel.
 */
export interface SpanWarning {
  type: string;
  message: string;
}

/**
 * One classified failure, before it becomes span attributes.
 *
 * `fatal: false` means "record it, keep going" — a schema mismatch on a tool that did
 * not promote it to an error. Such a classification lands as a {@link SpanWarning} and
 * leaves the span `ok`.
 */
export interface SpanFailure {
  errorType: SpanErrorType;
  /**
   * The slug the tool owner chose (`location_not_found`, `stale_data`), when the
   * classification came from the owner rather than from a platform rule.
   *
   * Separate from `errorType` because the two answer different questions: `errorType`
   * says which classifier fired and is drawn from a closed set, so it can back a filter
   * and a per-tool error rate; `code` is open-ended and says what the owner called this
   * particular failure. Folding the slug into `errorType` would let any string into a
   * closed vocabulary; dropping it leaves the owner no way to match one failure mode.
   */
  code?: string;
  message: string;
  fatal: boolean;
}

/**
 * Builds the `attributes` a classified span carries, merged onto whatever the caller
 * already collected.
 *
 * Both the fatal and the non-fatal case are handled here rather than at each call site,
 * so the two halves of step 2 (SDK-declared and catalog-declared) cannot drift in which
 * keys they set.
 *
 * @param base - Attributes the caller already built (`toolVersionId`, `executorType`, …).
 * @param failure - The winning classification, or `null` when nothing fired.
 * @param httpStatus - Upstream status, when the call reached an HTTP round trip.
 * @returns `attributes` ready for `CreateSpanInput`, plus the resolved span status and
 *   the `errorMessage` column value (null unless the failure was fatal).
 */
export function buildFailureAttributes(
  base: Record<string, unknown>,
  failure: SpanFailure | null,
  httpStatus?: number,
): { attributes: Record<string, unknown>; status: 'ok' | 'error'; errorMessage: string | null } {
  const attributes: Record<string, unknown> = { ...base };
  if (httpStatus !== undefined && httpStatus > 0) attributes.httpStatus = httpStatus;
  if (!failure) return { attributes, status: 'ok', errorMessage: null };

  attributes.errorType = failure.errorType;
  if (failure.code) attributes.errorCode = failure.code;
  attributes.errorDetail = failure.message;
  if (failure.fatal) return { attributes, status: 'error', errorMessage: failure.message };

  const warning: SpanWarning = { type: failure.code ?? failure.errorType, message: failure.message };
  attributes.warning = warning;
  return { attributes, status: 'ok', errorMessage: null };
}
