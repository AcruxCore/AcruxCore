import { randomUUID } from 'node:crypto';
import { ToolsRepository } from '../tools.repository';
import { ToolVersionsRepository } from '../versions/versions.repository';
import { ToolAliasesRepository } from '../aliases/aliases.repository';
import { SecretsRepository } from '../../secrets/secrets.repository';
import { decryptStoredSecret } from '../../gateway/connections/crypto';
import { safeFetch } from './safe-fetch';
import { compileTransform, evaluateTransform } from './js-transform';
import { NotFoundError, ValidationError, AppError } from '../../shared/errors';
import { SpansRepository } from '../../traces/spans/spans.repository';
import { buildFailureAttributes, type SpanFailure } from '../../traces/spans/span-failure';
import { validateAgainstSchema } from './result-schema';
import { runInTransaction } from '../../shared/db/unit-of-work';
import type { Executor } from '../versions/versions.types';
import type { ToolVersionRow } from '../versions/versions.types';
import type { ExecuteBodyDto, ExecuteResult } from './execute.types';

/** Wall-clock budget given to each requestTransform/responseTransform evaluation. */
const TRANSFORM_TIMEOUT_MS = 1000;

/**
 * Wall-clock budget for a `failureWhen` predicate. Shorter than a transform's: it only
 * inspects a response it was already handed, and a detector is never worth stalling a
 * tool call for.
 */
const FAILURE_WHEN_TIMEOUT_MS = 500;

/** A single header/query key-value pair, as stored on an http executor. */
interface KeyValue {
  name: string;
  value: string;
}

/**
 * Executes an `http` tool server-side and records a `tool` span.
 *
 * Wiring order per call: resolve the pinned version → validate arguments against
 * `parametersSchema` → run `requestTransform` (if any) → inject `{{secret.NAME}}`
 * references into headers/query (AFTER the transform, so team-authored JS never
 * sees decrypted secret values) → `safeFetch` the guarded request → run
 * `responseTransform` (if any) → write a best-effort `tool` span.
 */
export class ToolExecuteService {
  private readonly tools = new ToolsRepository();
  private readonly versions = new ToolVersionsRepository();
  private readonly aliases = new ToolAliasesRepository();
  private readonly secrets = new SecretsRepository();
  private readonly spans = new SpansRepository();

  /**
   * Resolves the target version (explicit number → alias → 'production'), validates
   * arguments, applies requestTransform, injects secrets, guards+sends the request,
   * applies responseTransform, and returns the result. Writes a `tool` span with the
   * toolVersionId (in attributes) and raw/transformed payloads.
   *
   * @param toolId - UUID of the tool to execute.
   * @param teamId - UUID of the authenticated user's team (isolation boundary).
   * @param dto - Validated execute body (arguments, optional alias/versionNumber/traceContext).
   * @returns The transformed result, the upstream HTTP status, latency, and the executed toolVersionId.
   * @throws {NotFoundError} Tool/version/alias missing.
   * @throws {ValidationError} Args fail the schema, or a transform/request errors (400).
   * @throws {AppError} 422 `NOT_EXECUTABLE` — the resolved version has no server-side (`client`) executor.
   */
  async execute(toolId: string, teamId: string, dto: ExecuteBodyDto): Promise<ExecuteResult> {
    const tool = await this.tools.findById(toolId, teamId);
    if (!tool) throw new NotFoundError('Tool not found.');

    const version = await this.resolveVersion(toolId, dto);
    const executor = version.executor as unknown as Executor;
    if (executor.type !== 'http') {
      throw new AppError('This tool has no server-side executor.', 422, 'NOT_EXECUTABLE');
    }

    const argFailure = this.assertArgs(version.parametersSchema, dto.arguments);

    // 0) refuse, before anything is built. Not `aborting` below: a model that sent a
    // bad argument gets a recorded tool failure it can read and retry from, exactly as
    // issue #452 asks, rather than an exception that ends the whole agent loop.
    // `transport` is the honest error type — no request is made — and the `code` slug
    // says which rule refused it. Deciding here means a refused call never runs the
    // team's requestTransform and never decrypts a secret.
    const unsafeArgs = this.traversingUrlArgs(executor.url, dto.arguments);
    const refused: SpanFailure | null = unsafeArgs.length
      ? {
          errorType: 'transport',
          code: 'unsafe_url_argument',
          message: `Argument ${unsafeArgs.map((n) => `'${n}'`).join(', ')} may not contain '..' or be a lone '.': it would move the request outside the path this tool declares.`,
          fatal: true,
        }
      : argFailure
        ? { errorType: 'transport', code: 'invalid_arguments', message: argFailure, fatal: true }
        : null;

    // 1) build the request body (requestTransform, or raw arguments if none is defined)
    let requestTransformApplied = false;
    let body: unknown = dto.arguments;
    if (!refused && executor.requestTransform) {
      try {
        body = await evaluateTransform(
          compileTransform(executor.requestTransform),
          dto.arguments,
          TRANSFORM_TIMEOUT_MS,
        );
        requestTransformApplied = true;
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : 'requestTransform failed');
      }
    }

    // 2) headers/query resolution — always AFTER the transform, so a team-authored
    // transform never receives a decrypted secret value as input. Each value has its
    // {{secret.NAME}} refs resolved first (trusted), then its {{arg.NAME}} refs (the
    // model's arguments, inserted last so they can never be re-read as a secret ref).
    const resolvedHeaders = refused ? [] : await this.resolveValues(executor.headers, teamId, dto.arguments);
    const resolvedQuery = refused ? [] : await this.resolveValues(executor.query, teamId, dto.arguments);
    const headers: Record<string, string> = Object.fromEntries(resolvedHeaders.map((h) => [h.name, h.value]));
    // Args may also be templated into the URL itself (e.g. a /{{arg.id}} path segment);
    // secrets are deliberately NOT injected into the URL, to keep them out of request lines.
    const url = refused ? '' : this.buildUrl(this.substituteArgs(executor.url, dto.arguments, 'url'), resolvedQuery);

    // 3) guarded request
    const started = Date.now();
    let status = 0;
    let rawBody: unknown = null;
    // A classification that also ABORTS the call: the transport never delivered a
    // response, or team-authored JS blew up. These keep the pre-issue-#452 behaviour of
    // throwing, because there is genuinely no result to hand the model.
    let aborting: SpanFailure | null = null;
    if (!refused) {
      try {
        const method = executor.method;
        const res = await safeFetch(url, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
        });
        status = res.status;
        rawBody = res.body;
      } catch (e) {
        aborting = {
          errorType: 'transport',
          message: e instanceof Error ? e.message : 'request failed',
          fatal: true,
        };
      }
    }
    const latencyMs = Date.now() - started;

    // 4) responseTransform — runs on a non-2xx too, because that body is still what the
    // model is about to read, and a transform is how a tool normalises an error shape.
    let responseTransformApplied = false;
    let result: unknown = rawBody;
    if (!aborting && !refused && executor.responseTransform) {
      try {
        result = await evaluateTransform(
          compileTransform(executor.responseTransform),
          { status, headers: {}, body: rawBody },
          TRANSFORM_TIMEOUT_MS,
        );
        responseTransformApplied = true;
      } catch (e) {
        aborting = {
          errorType: 'transform',
          message: e instanceof Error ? e.message : 'responseTransform failed',
          fatal: true,
        };
      }
    }

    // 5) classify — the heart of issue #452. Everything below this line RECORDS and
    // RETURNS; only the two aborting cases above still throw. Whether a failed tool call
    // stops the agent is the caller's decision; whether the trace tells the truth is ours,
    // and conflating the two would change the behaviour of every existing tool loop.
    const detected = refused
      ? [refused]
      : aborting
        ? [aborting]
        : await this.classify(executor, status, rawBody, result);
    // Most-authoritative-wins: the first detector to fire owns the span's status, the
    // rest ride along in `alsoDetected` so a second signal is never lost.
    const winner = detected[0] ?? null;

    const { attributes, status: spanStatus, errorMessage } = buildFailureAttributes(
      {
        toolVersionId: version.id,
        executorType: 'http',
        transformApplied: requestTransformApplied || responseTransformApplied,
        ...(detected.length > 1
          ? { alsoDetected: detected.slice(1).map((f) => ({ errorType: f.errorType, message: f.message })) }
          : {}),
      },
      winner,
      status,
    );

    // 6) tool span (best-effort — tracing must never fail the execution it observes)
    await this.recordSpan(teamId, tool.name, dto, body, result, latencyMs, {
      attributes,
      status: spanStatus,
      errorMessage,
    });

    if (aborting) throw new ValidationError(aborting.message);
    return {
      result,
      status,
      latencyMs,
      toolVersionId: version.id,
      ...(winner && winner.fatal ? { error: { type: winner.errorType, message: winner.message } } : {}),
      ...(winner && !winner.fatal ? { warning: { type: winner.errorType, message: winner.message } } : {}),
    };
  }

  /**
   * Runs every failure detector that applies to a completed call, most authoritative
   * first: the protocol's own verdict, then the tool owner's `failureWhen`, then the
   * declared `resultSchema`.
   *
   * The order is the point. A non-2xx is a fact; `failureWhen` is the owner's judgement
   * about a response that looked fine to the protocol; a schema mismatch is the weakest
   * signal, because our own declaration may be the wrong one.
   *
   * @param executor - The resolved http executor, carrying the optional declarations.
   * @param status - Upstream HTTP status.
   * @param rawBody - The response body BEFORE `responseTransform`.
   * @param result - The response AFTER `responseTransform` — what the model will read.
   * @returns Every classification that fired, most authoritative first. Empty on success.
   */
  private async classify(
    executor: Extract<Executor, { type: 'http' }>,
    status: number,
    rawBody: unknown,
    result: unknown,
  ): Promise<SpanFailure[]> {
    const found: SpanFailure[] = [];

    if (status < 200 || status >= 300) {
      found.push({
        errorType: 'http_status',
        message: `Upstream returned HTTP ${status}.`,
        fatal: true,
      });
    }

    if (executor.failureWhen) {
      // Deliberately the RAW body: a responseTransform is free to drop the very field
      // that carried the error, and a detector reading the cleaned-up result would then
      // never see it.
      try {
        const verdict = await evaluateTransform(
          compileTransform(executor.failureWhen),
          { status, headers: {}, body: rawBody },
          FAILURE_WHEN_TIMEOUT_MS,
        );
        if (verdict !== null && verdict !== undefined && verdict !== false) {
          const v = (typeof verdict === 'object' ? verdict : {}) as { type?: unknown; message?: unknown };
          found.push({
            errorType: 'tool_declared',
            // The owner's own slug for this failure mode, kept beside the closed-vocabulary
            // `errorType` — the same attribute the SDKs write from ToolResult/toolError, so
            // one `errorCode` means the same thing whoever ran the tool.
            ...(typeof v.type === 'string' && v.type ? { code: v.type } : {}),
            message: typeof v.message === 'string' && v.message ? v.message : 'The tool declared this call a failure.',
            fatal: true,
          });
        }
      } catch (e) {
        // A broken detector is a warning, never a failure: reporting the tool call as
        // failed because our own predicate threw would invent an outage that never
        // happened. It still has to be visible, or the tool silently stops being checked.
        found.push({
          errorType: 'transform',
          message: `failureWhen did not run: ${e instanceof Error ? e.message : 'unknown error'}`,
          fatal: false,
        });
      }
    }

    if (executor.resultSchema) {
      // The TRANSFORMED result, because that is the object handed to the model — the
      // contract is what we produce, not what upstream sent.
      const mismatch = validateAgainstSchema(result, executor.resultSchema);
      if (mismatch) {
        found.push({
          errorType: 'schema_mismatch',
          message: mismatch,
          fatal: executor.resultSchemaSeverity === 'error',
        });
      }
    }

    // A non-fatal classification never outranks a fatal one, whatever the detector order.
    return [...found.filter((f) => f.fatal), ...found.filter((f) => !f.fatal)];
  }

  /**
   * Resolves the tool version to execute against: an explicit `versionNumber` wins,
   * otherwise the named (or default `production`) alias is followed.
   *
   * @throws {NotFoundError} The requested version/alias, or its target version row, does not exist.
   */
  private async resolveVersion(toolId: string, dto: ExecuteBodyDto): Promise<ToolVersionRow> {
    if (dto.versionNumber !== undefined) {
      const v = await this.versions.findByVersionNumber(toolId, dto.versionNumber);
      if (!v) throw new NotFoundError(`Version ${dto.versionNumber} not found.`);
      return v;
    }
    const aliasName = dto.alias ?? 'production';
    const alias = await this.aliases.findByAlias(toolId, aliasName);
    if (!alias) throw new NotFoundError(`Alias '${aliasName}' not found.`);
    const v = await this.versions.findByVersionNumber(toolId, alias.versionNumber);
    if (!v) throw new NotFoundError('Resolved version not found.');
    return v;
  }

  /**
   * Checks the caller's arguments against the tool version's `parametersSchema`.
   *
   * `parametersSchema` is what the model is shown as the function's
   * `parameters`, so an author who writes `enum`, `maximum` or
   * `additionalProperties: false` there is describing a real constraint on
   * their own upstream service. Only `required` used to be enforced, so every
   * other constraint the author wrote was forwarded straight past (issue
   * #506): a model's out-of-range `limit`, or an invented `sort`, reached
   * their API with a 200 and no signal that anything was off contract.
   *
   * **A missing `required` argument still throws; every other violation does not.**
   * That split is deliberate. Missing-required has thrown a 400 since long before
   * #506, so callers are built around it. The checks #506 added — type, `enum`,
   * numeric and string bounds, `additionalProperties` — catch the mistakes a model
   * actually makes: `limit: "3"` for an integer, an invented key against a closed
   * object. Throwing on those would abort the caller's whole agent loop (neither SDK
   * wraps `tools.execute` in a try/catch) and write no tool span at all, so the trace
   * would show the model asking for a tool and then nothing. They are returned as a
   * recorded tool failure instead, which is the issue-#452 contract this file follows
   * everywhere else, and which lets the model read what was wrong and try again.
   *
   * Uses the same checker as the result side ({@link validateAgainstSchema}),
   * with `bounds` turned on — see `result-schema.ts`'s header for why the two
   * callers want different strictness. Keywords outside that subset
   * (`anyOf`, `$ref`, `pattern`, …) are still ignored rather than rejected, so
   * an unsupported keyword can never manufacture a false rejection.
   *
   * @param schema - The version's `parametersSchema`, of unknown shape.
   * @param args - The caller-supplied arguments.
   * @returns The violated rule, or null when the arguments satisfy the schema.
   * @throws {ValidationError} A required property is missing.
   */
  private assertArgs(schema: unknown, args: Record<string, unknown>): string | null {
    const s = schema as { required?: string[] };
    for (const req of s.required ?? []) {
      if (!(req in args)) throw new ValidationError(`Missing required argument: ${req}`);
    }

    return validateAgainstSchema(args, schema, 'arguments', { bounds: true });
  }

  /**
   * Resolves `{{secret.NAME}}` then `{{arg.NAME}}` references in every header/query
   * value for a team. Secrets first (trusted, team-authored), arguments last
   * (model-controlled), so an argument value can never be re-interpreted as a secret
   * reference — see {@link substituteArgs}.
   *
   * @throws {ValidationError} A referenced secret no longer exists for the team.
   */
  private async resolveValues(pairs: KeyValue[], teamId: string, args: Record<string, unknown>): Promise<KeyValue[]> {
    return Promise.all(
      pairs.map(async (p) => ({
        name: p.name,
        value: this.substituteArgs(await this.resolveRefs(p.value, teamId), args),
      })),
    );
  }

  /**
   * Substitutes every `{{arg.NAME}}` occurrence in `value` with the string form of the
   * caller-supplied argument `NAME`; a missing/null argument resolves to an empty string.
   *
   * Three deliberate properties:
   * - Runs AFTER {@link resolveRefs}, so a model-controlled argument value that happens
   *   to contain the literal text `{{secret.X}}` is never resolved into a real secret
   *   (it is inserted verbatim instead) — this closes an exfiltration vector.
   * - Uses a replacer FUNCTION, so an argument value containing `$`-sequences (`$&`, `$1`,
   *   `$$`) is inserted literally rather than treated as a `String.replace` pattern.
   * - When substituting into the **URL** (`target: 'url'`), the value is
   *   percent-encoded. An argument is a value, not URL syntax: left raw, an `id` of
   *   `../../internal/admin` turns the author's `https://host/v1/public/{{arg.id}}`
   *   into a call to `https://host/internal/admin` once `new URL()` normalizes it,
   *   and `1?role=admin` appends a query parameter the author never declared — both
   *   carrying whatever `{{secret.*}}` header the tool sends. Encoding keeps the
   *   value inside the one path segment (or one query value) the author wrote it
   *   into. Header and query values are NOT encoded here: `URLSearchParams` already
   *   encodes query values, and a header value is not a URL.
   *
   * @param value - A header/query/url template that may contain `{{arg.NAME}}` refs.
   * @param args - The validated tool arguments supplied on the execute request.
   * @param target - `'url'` percent-encodes each substituted value; `'value'` (the
   *   default, used for header and query values) inserts it verbatim.
   * @returns The value with every `{{arg.NAME}}` replaced by its argument's string form.
   */
  private substituteArgs(
    value: string,
    args: Record<string, unknown>,
    target: 'url' | 'value' = 'value',
  ): string {
    const re = /\{\{\s*arg\.([a-zA-Z0-9_]{1,64})\s*\}\}/g;
    return value.replace(re, (_match, name: string) => {
      const v = args[name];
      if (v === undefined || v === null) return '';
      const raw = String(v);
      // Encoding stops a value SPANNING segments in OUR request line, which is the
      // right thing for a client to do. It cannot stop a value from BEING a dot-segment,
      // and it cannot decide what an upstream does with a `%2F` it receives. Those cases
      // are refused before the request is built, in {@link traversingUrlArgs}.
      return target === 'url' ? encodeURIComponent(raw) : raw;
    });
  }

  /**
   * Names the URL-templated arguments carrying a relative-path escape, which encoding
   * cannot neutralise.
   *
   * Two separate things defeat encoding here, which is why this refuses rather than
   * escapes:
   *
   * 1. `encodeURIComponent` leaves `.` untouched — it is unreserved — and `new URL()`
   *    in {@link buildUrl} then resolves dot-segments away. So `/v1/orders/{{arg.id}}/items`
   *    with `id: '..'` becomes `/v1/items` before the request is even built: a different
   *    collection, reached with the order API's `{{secret.*}}` headers. Percent-encoding
   *    the dots does not help, because the URL parser counts `%2e`, `.%2e` and `%2e%2e`
   *    as dot-segments too.
   *
   * 2. The encoded `%2F` in a value like `../../admin` survives our request line, but the
   *    UPSTREAM decides what it means. Many servers and proxies percent-decode the path
   *    before routing and then resolve the dot-segments themselves — verified against a
   *    real public echo, which reported the path it received as
   *    `/v1/public/../../internal/admin`. Encoding is the right thing for a client to do
   *    and it is still done; it just cannot be the guarantee, because the guarantee would
   *    depend on every upstream's normalisation settings.
   *
   * So any `..` in a URL-substituted value is refused, along with a lone `.`. A path
   * argument meaning "the parent" addresses no resource of the author's, which keeps the
   * rule nearly free of legitimate casualties: `report.pdf`, `1.2.3` and
   * `user@example.com` all pass through untouched, because a single dot between other
   * characters is neither a dot-segment nor a traversal.
   *
   * @param urlTemplate - The executor's raw URL, with its `{{arg.NAME}}` refs intact.
   * @param args - The validated tool arguments supplied on the execute request.
   * @returns The offending argument names, in template order; empty when the URL is safe.
   */
  private traversingUrlArgs(urlTemplate: string, args: Record<string, unknown>): string[] {
    const re = /\{\{\s*arg\.([a-zA-Z0-9_]{1,64})\s*\}\}/g;
    const bad: string[] = [];
    for (const match of urlTemplate.matchAll(re)) {
      const v = args[match[1]];
      if (v === undefined || v === null) continue;
      const raw = String(v);
      if (raw === '.' || raw.includes('..')) bad.push(match[1]);
    }
    return bad;
  }

  /**
   * Substitutes every `{{secret.NAME}}` occurrence in `value` with the decrypted secret.
   *
   * The replacement is done via a replacer FUNCTION, not a replacement string:
   * `String.prototype.replace`'s second argument, when a string, treats sequences
   * like `$&`/`$1`/`$$` as special substitution patterns rather than literal text.
   * A secret's plaintext value is a perfectly normal string that may contain `$`
   * (e.g. an API key like `sk-abc$def`) — passing it as the replacement STRING would
   * silently corrupt it (`$&` gets replaced with the whole match, a trailing lone
   * `$` can throw or drop characters). A replacer function's return value is always
   * inserted literally, with no pattern interpretation, so this is the only safe form.
   *
   * @throws {ValidationError} A referenced secret no longer exists for the team.
   */
  private async resolveRefs(value: string, teamId: string): Promise<string> {
    const re = /\{\{\s*secret\.([A-Z0-9_]{1,64})\s*\}\}/g;
    const matches = [...value.matchAll(re)];
    let out = value;
    for (const m of matches) {
      const secret = await this.secrets.findByNameForTeam(m[1]!, teamId);
      if (!secret) throw new ValidationError(`Referenced secret '${m[1]}' no longer exists.`);
      const plaintext = decryptStoredSecret(secret.secretCiphertext, 'tool_secret', m[1]);
      out = out.replace(m[0], () => plaintext);
    }
    return out;
  }

  /** Builds the final request URL from the executor's base URL and resolved query params. */
  private buildUrl(base: string, resolvedQuery: KeyValue[]): string {
    const u = new URL(base);
    for (const q of resolvedQuery) u.searchParams.set(q.name, q.value);
    return u.toString();
  }

  /**
   * Writes a `tool` span (+ trace, if none was supplied) for this execution.
   * Tracing is best-effort: any failure here is logged and swallowed, never
   * thrown, so a span-write error can never fail an otherwise-successful (or
   * otherwise-failed, for its own reasons) tool execution.
   *
   * `classified` arrives pre-built from {@link buildFailureAttributes} rather than being
   * derived here, so the platform executor and the SDK's client-side executor write the
   * identical span shape — the thing that keeps `error_type:` filters and per-tool error
   * rate counting one population instead of two.
   */
  private async recordSpan(
    teamId: string,
    toolName: string,
    dto: ExecuteBodyDto,
    sentBody: unknown,
    result: unknown,
    latencyMs: number,
    classified: {
      attributes: Record<string, unknown>;
      status: 'ok' | 'error';
      errorMessage: string | null;
    },
  ): Promise<void> {
    try {
      await runInTransaction(async (tx) => {
        const startedAt = new Date(Date.now() - latencyMs);
        // Resolve the trace the caller asked for. An id we already own is appended to;
        // an id nobody owns is CREATED with that id (same contract as POST /traces), so
        // a client agent loop can mint one trace id up front and have the tool span land
        // in it regardless of call order. Only another team's id is refused — falling
        // back to a fresh trace rather than leaking or colliding.
        let traceId = dto.traceContext?.traceId;
        let parentSpanRef = dto.traceContext?.parentSpanId ?? null;
        if (traceId) {
          const existing = await this.spans.findTraceById(traceId, tx);
          if (existing && existing.teamId !== teamId) {
            traceId = undefined;
            parentSpanRef = null; // the parent belonged to that other trace
          } else if (!existing) {
            await this.spans.createTrace({ id: traceId, teamId, name: `tool:${toolName}`, startedAt }, tx);
            // Nothing else is in this trace yet, so a supplied parent cannot resolve.
            parentSpanRef = null;
          }
        }
        if (!traceId) {
          const trace = await this.spans.createTrace({ teamId, name: `tool:${toolName}`, startedAt }, tx);
          traceId = trace.id;
        }
        const span = await this.spans.appendSpan(
          {
            teamId,
            traceId,
            spanRef: randomUUID(),
            parentSpanRef,
            kind: 'tool',
            name: toolName,
            status: classified.status,
            startedAt,
            endedAt: new Date(),
            latencyMs,
            errorMessage: classified.errorMessage,
            attributes: classified.attributes,
          },
          tx,
        );
        await this.spans.writePayload(
          span.id,
          teamId,
          {
            // The upstream body is stored even when the call is classified as failed —
            // "what did it actually say" is the first question anyone asks of a red span,
            // and replacing it with the classifier's own message threw that away.
            input: sentBody as object,
            output: result as object,
            variables: dto.arguments,
          },
          tx,
        );
      });
    } catch (err) {
      console.error('[tools] execute span write failed', err);
    }
  }
}
