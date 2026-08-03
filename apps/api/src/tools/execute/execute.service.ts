import { randomUUID } from 'node:crypto';
import { ToolsRepository } from '../tools.repository';
import { ToolVersionsRepository } from '../versions/versions.repository';
import { ToolAliasesRepository } from '../aliases/aliases.repository';
import { SecretsRepository } from '../../secrets/secrets.repository';
import { decryptSecret } from '../../gateway/connections/crypto';
import { safeFetch } from './safe-fetch';
import { compileTransform, evaluateTransform } from './js-transform';
import { NotFoundError, ValidationError, AppError } from '../../shared/errors';
import { SpansRepository } from '../../traces/spans/spans.repository';
import { runInTransaction } from '../../shared/db/unit-of-work';
import type { Executor } from '../versions/versions.types';
import type { ToolVersionRow } from '../versions/versions.types';
import type { ExecuteBodyDto, ExecuteResult } from './execute.types';

/** Wall-clock budget given to each requestTransform/responseTransform evaluation. */
const TRANSFORM_TIMEOUT_MS = 1000;

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

    this.assertArgs(version.parametersSchema, dto.arguments);

    // 1) build the request body (requestTransform, or raw arguments if none is defined)
    let requestTransformApplied = false;
    let body: unknown = dto.arguments;
    if (executor.requestTransform) {
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
    const resolvedHeaders = await this.resolveValues(executor.headers, teamId, dto.arguments);
    const resolvedQuery = await this.resolveValues(executor.query, teamId, dto.arguments);
    const headers: Record<string, string> = Object.fromEntries(resolvedHeaders.map((h) => [h.name, h.value]));
    // Args may also be templated into the URL itself (e.g. a /{{arg.id}} path segment);
    // secrets are deliberately NOT injected into the URL, to keep them out of request lines.
    const url = this.buildUrl(this.substituteArgs(executor.url, dto.arguments), resolvedQuery);

    // 3) guarded request
    const started = Date.now();
    let status = 0;
    let rawBody: unknown = null;
    let errorMessage: string | null = null;
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
      errorMessage = e instanceof Error ? e.message : 'request failed';
    }
    const latencyMs = Date.now() - started;

    // 4) responseTransform
    let responseTransformApplied = false;
    let result: unknown = rawBody;
    if (!errorMessage && executor.responseTransform) {
      try {
        result = await evaluateTransform(
          compileTransform(executor.responseTransform),
          { status, headers: {}, body: rawBody },
          TRANSFORM_TIMEOUT_MS,
        );
        responseTransformApplied = true;
      } catch (e) {
        errorMessage = e instanceof Error ? e.message : 'responseTransform failed';
      }
    }

    // 5) tool span (best-effort — tracing must never fail the execution it observes)
    await this.recordSpan(
      teamId,
      tool.name,
      version.id,
      dto,
      body,
      result,
      status,
      latencyMs,
      errorMessage,
      requestTransformApplied || responseTransformApplied,
    );

    if (errorMessage) throw new ValidationError(errorMessage);
    return { result, status, latencyMs, toolVersionId: version.id };
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
   * Lightweight argument validation: checks that every property named in the
   * schema's top-level `required` array is present. This is intentionally not a
   * full JSON-Schema validator (no `ajv` dependency was already present in this
   * package) — it is enough to satisfy the "missing required argument" 400 case.
   *
   * @throws {ValidationError} A required property is missing from `args`.
   */
  private assertArgs(schema: unknown, args: Record<string, unknown>): void {
    const s = schema as { required?: string[] };
    for (const req of s.required ?? []) {
      if (!(req in args)) throw new ValidationError(`Missing required argument: ${req}`);
    }
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
   * Two deliberate properties:
   * - Runs AFTER {@link resolveRefs}, so a model-controlled argument value that happens
   *   to contain the literal text `{{secret.X}}` is never resolved into a real secret
   *   (it is inserted verbatim instead) — this closes an exfiltration vector.
   * - Uses a replacer FUNCTION, so an argument value containing `$`-sequences (`$&`, `$1`,
   *   `$$`) is inserted literally rather than treated as a `String.replace` pattern.
   *
   * @param value - A header/query/url template that may contain `{{arg.NAME}}` refs.
   * @param args - The validated tool arguments supplied on the execute request.
   * @returns The value with every `{{arg.NAME}}` replaced by its argument's string form.
   */
  private substituteArgs(value: string, args: Record<string, unknown>): string {
    const re = /\{\{\s*arg\.([a-zA-Z0-9_]{1,64})\s*\}\}/g;
    return value.replace(re, (_match, name: string) => {
      const v = args[name];
      return v === undefined || v === null ? '' : String(v);
    });
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
      const plaintext = decryptSecret(secret.secretCiphertext);
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
   */
  private async recordSpan(
    teamId: string,
    toolName: string,
    versionId: string,
    dto: ExecuteBodyDto,
    sentBody: unknown,
    result: unknown,
    status: number,
    latencyMs: number,
    errorMessage: string | null,
    transformApplied: boolean,
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
            status: errorMessage ? 'error' : 'ok',
            startedAt,
            endedAt: new Date(),
            latencyMs,
            errorMessage,
            attributes: { toolVersionId: versionId, executorType: 'http', transformApplied },
          },
          tx,
        );
        await this.spans.writePayload(
          span.id,
          teamId,
          {
            input: sentBody as object,
            output: (errorMessage ? { error: errorMessage } : result) as object,
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
