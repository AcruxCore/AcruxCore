import type { ProviderConnection } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ConnectionsRepository } from '../connections/connections.repository';
import { decryptSecret } from '../connections/crypto';
import { GatewayRepository } from './gateway.repository';
import { BudgetsRepository } from '../budgets/budgets.repository';
import { checkAndRecord, recordTokens } from '../budgets/rate-limiter';
import {
  budgetPeriodKey,
  detectBudgetCrossings,
  type BudgetCrossing,
} from '../budgets/thresholds';
// Concrete file, not the `../../notifications` barrel — that barrel re-exports
// `notificationsRouter` and would pull Express into apps/worker's graph (same
// concern as the `AliasesService` import below).
import { notify } from '../../notifications/notify';
import { appLink } from '../../email';
import { getAdapter, ProviderError } from '../providers/adapter';
import { computeCostFromPrices } from '../providers/models';
import { estimateTokens } from '../providers/token-estimate';
import type { ChatMessage, NormalizedRequest, ProviderCredentials, StreamChunk, ToolCall, Usage } from '../providers/types';
// Imported from the concrete file, not the `../../prompts/aliases` barrel:
// that barrel also re-exports `aliasesRouter`/`renderRouter`, which pulls in
// Express as a load-time side effect of the barrel's single `require()`. This
// class only needs `AliasesService` (business logic, no HTTP), and this
// service is itself required by `cell.processor.ts` — which apps/worker's
// narrowed `evaluations/runs/processors` export surface pulls in — so an
// Express-free import here keeps apps/worker's dependency graph Express-free
// end to end.
import { AliasesService } from '../../prompts/aliases/aliases.service';
import { renderMessages, NunjucksRenderError } from '../../prompts/versions/nunjucks.utils';
// Imported from the concrete sub-barrel, not the top-level `../../tools` barrel:
// that barrel also re-exports `toolsRouter`, which pulls in Express as a load-time
// side effect (same Express-free-graph concern as the `AliasesService` import above).
import { ToolResolver, ToolRefNotFoundError } from '../../tools/resolver';
import type { ResolvedToolDefinition } from '../../tools/resolver';
import { randomUUID } from 'node:crypto';
import { resolveDeployments, callWithFallback, FallbackExhaustedError } from './router';
import type { DeploymentInvoker, ResolvedDeployment } from './router';
import type { GatewayCallContext, GatewayCompletionRequest, GatewayResult } from './completions.types';
import { CacheRepository } from '../cache/cache.repository';
import { computeCacheKey } from '../cache/cache-key';
import { recordGatewaySpan } from '../../traces/ingest/gateway-trace.hook';
import {
  AppError,
  BadGatewayError,
  GatewayTimeoutError,
  ForbiddenError,
  PaymentRequiredError,
  RateLimitedError,
  ValidationError,
} from '../../shared/errors';
import { runInTransaction } from '../../shared/db/unit-of-work';

/** Default same-connection retries when the request omits a `gateway.maxRetries` override. */
const DEFAULT_MAX_RETRIES = 1;

/**
 * Per-call options for GatewayService.complete that are not part of the key's
 * persistent scope (GatewayCallContext).
 */
export interface CompleteOptions {
  /** Bypass cache lookup AND store for this call (from `x-gateway-cache: no-store`). */
  noStore?: boolean;
}

/** Outcome the controller reports back to {@link GatewayStream.finalize}. */
export interface FinalizeStreamOpts {
  /** 'success' if the stream completed or the client simply disconnected; 'error' on a provider mid-stream failure. */
  status: 'success' | 'error';
  /** Error code to persist in `error_code` when `status === 'error'`. */
  errorCode?: string;
  /** True when the caller disconnected mid-stream; recorded in `meta.clientAborted`. */
  clientAborted?: boolean;
}

/**
 * Handle returned by {@link GatewayService.completeStream}. The pre-call pipeline
 * and provider selection have already run; the first provider chunk is buffered
 * inside `chunks`, so consuming it will not fail with a pre-first-chunk error
 * (those are thrown by `completeStream` itself).
 */
export interface GatewayStream {
  /** Pre-generated request id; also the `gateway_requests.id` written by `finalize`. */
  requestId: string;
  /** Provider actually selected (e.g. 'openai'). */
  provider: string;
  /** Resolved model actually called. */
  resolvedModel: string;
  /** Connection used, or null if none was resolvable. */
  providerConnectionId: string | null;
  /**
   * Trace this stream's `llm` span will be filed under — the caller's `x-trace-id`
   * when supplied, else freshly minted. Known before the first chunk so the
   * controller can flush it as `x-gateway-trace-id`.
   */
  traceId: string;
  /** Ref of the span `finalize` will write, likewise available before the first chunk. */
  spanRef: string;
  /** Async generator of normalized chunks; accumulates text + usage internally. */
  chunks: AsyncGenerator<StreamChunk>;
  /** Persist the request row and increment budgets in one transaction. Idempotent per handle. */
  finalize(opts: FinalizeStreamOpts): Promise<void>;
  /** Tear down the upstream provider stream (called by the controller on client disconnect). */
  abort(): void;
}

/** A budget row after lazy reset, as returned by the reserve helper. */
type FreshBudget = Awaited<ReturnType<BudgetsRepository['applicableBudgets']>>[number];

/**
 * Conservative fallback for a request's completion-token reservation estimate
 * when the caller didn't supply `max_tokens` — bounds the worst case without
 * requiring per-model context-window knowledge. Tunable later; the point is
 * that *some* bound exists.
 */
const DEFAULT_ESTIMATED_COMPLETION_TOKENS = 1000;

/**
 * Conservative pre-call cost estimate used to RESERVE budget headroom before
 * the paid provider call (G4/G5 fix — see `GatewayService.reserveBudgets`):
 * the real prompt-token count (same estimator the streaming path already uses
 * for its usage fallback) plus the caller's own `max_tokens` cap — or
 * `DEFAULT_ESTIMATED_COMPLETION_TOKENS` when omitted — as the completion-token
 * estimate, priced at the given model's registered rates.
 *
 * @param req - The normalized request (messages + optional max_tokens).
 * @param model - The pricing to estimate against — the primary deployment's,
 *   since fallback deployments for the same model are normally priced the same.
 * @returns The estimated USD cost, or 0 for an unpriced model — matching how a
 *   real, unpriced completion is already recorded as 0 spend elsewhere here.
 */
function estimateRequestCostUsd(
  req: NormalizedRequest,
  model: { inputPricePerM: Prisma.Decimal | null; outputPricePerM: Prisma.Decimal | null },
): number {
  const promptTokens = estimateTokens(req.messages, req.model);
  const completionTokens = req.max_tokens ?? DEFAULT_ESTIMATED_COMPLETION_TOKENS;
  return (
    computeCostFromPrices(model.inputPricePerM, model.outputPricePerM, {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    }) ?? 0
  );
}

// Reads the base_url out of a connection's JSONB config (openai_compatible only).
function connectionBaseUrl(config: unknown): string | undefined {
  const c = (config ?? {}) as Record<string, unknown>;
  return typeof c['base_url'] === 'string' ? (c['base_url'] as string) : undefined;
}

/**
 * B1 ad-hoc templating, made tool-aware (TC2): renders `{{ variables }}` into each
 * message's `content` using the same nunjucks engine as prompt versions. A message
 * with `content: null` (an assistant message that only carries `tool_calls`) has
 * nothing to render and is passed through unchanged — `renderMessages` itself only
 * accepts string content, so templating tool-call arguments is out of scope here.
 *
 * @param messages - Ad-hoc messages, possibly including tool-role/tool_calls entries.
 * @param variables - Key-value map of variable values to inject.
 * @returns The same messages with non-null `content` rendered.
 * @throws {NunjucksRenderError} If nunjucks encounters a runtime error during rendering,
 *   or the render sandbox's timeout/memory limit is hit.
 */
async function renderAdhocMessages(messages: ChatMessage[], variables: Record<string, unknown>): Promise<ChatMessage[]> {
  const rendered = await renderMessages(
    messages.map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content ?? '' })),
    variables,
  );
  return messages.map((m, i) => ({ ...m, content: m.content === null ? null : rendered[i]!.content }));
}

/**
 * Core (non-streaming) completion pipeline. Later steps splice their stages into the
 * numbered stitch points (← Gx). G5 replaces G2's single-connection resolve+call with
 * priority/round-robin routing (`resolveConnections`) and retry/fallback
 * (`callWithFallback`), recording the served connection + attempt trail on the row.
 */
export class GatewayService {
  private readonly cache = new CacheRepository();
  /** Phase 1 render engine, reused for prompt-reference calls (G8 lineage). */
  private readonly aliases = new AliasesService();
  /** TC2 Task 5: resolves catalog `tool_refs` into OpenAI tool definitions. */
  private readonly toolResolver = new ToolResolver();

  constructor(
    private readonly gatewayRepo: GatewayRepository,
    private readonly connectionsRepo: ConnectionsRepository,
    private readonly budgetsRepo: BudgetsRepository = new BudgetsRepository(),
  ) {}

  /**
   * Whether this call may read from / write to the cache. Requires: caching
   * enabled on the key (cacheTtlSeconds > 0), no no-store bypass, non-streaming,
   * and an EXPLICIT temperature of 0 (deterministic — see the G6 temperature-gate
   * decision; an omitted temperature means the provider default, which is not cached).
   *
   * @param ctx - The team + key call context (carries cacheTtlSeconds).
   * @param req - The normalized request whose sampling params gate cacheability.
   * @param opts - Per-call options; `noStore` disables caching entirely.
   * @returns true when the call is eligible for cache read/write.
   */
  private isCacheable(ctx: GatewayCallContext, req: GatewayCompletionRequest, opts?: CompleteOptions): boolean {
    return (
      ctx.cacheTtlSeconds != null &&
      ctx.cacheTtlSeconds > 0 &&
      opts?.noStore !== true &&
      req.stream !== true &&
      req.temperature === 0
    );
  }

  /**
   * Enforce the virtual key's model allow-list (G3) by public model name. Runs
   * before deployment resolution so a scoped-out model 403s regardless of the
   * team's registry. null/empty = unrestricted.
   * @throws {ForbiddenError} MODEL_NOT_ALLOWED when scoped out.
   */
  private assertModelAllowed(ctx: GatewayCallContext, model: string): void {
    if (ctx.allowedModels && ctx.allowedModels.length > 0 && !ctx.allowedModels.includes(model)) {
      throw new ForbiddenError('MODEL_NOT_ALLOWED', `Model '${model}' is not allowed for this key.`);
    }
  }

  /**
   * Enforce the virtual key's provider allow-list (G3) using the provider of the
   * resolved deployment's credential (no more name inference). null/empty = unrestricted.
   * @throws {ForbiddenError} PROVIDER_NOT_ALLOWED when scoped out.
   */
  private assertProviderAllowed(ctx: GatewayCallContext, provider: string): void {
    if (ctx.allowedProviders && ctx.allowedProviders.length > 0 && !ctx.allowedProviders.includes(provider)) {
      throw new ForbiddenError('PROVIDER_NOT_ALLOWED', `Provider '${provider}' is not allowed for this key.`);
    }
  }

  /**
   * TC3 Task 5: merges a stored prompt version's resolved (auto-attached) tools
   * onto `req.tools`, mutating `req` in place. Unlike `resolveAndMergeTools`'s
   * `tool_refs` collision handling (a 400), a name shared with an inline tool is
   * a **benign override** here — the caller's own inline re-declaration of one of
   * the prompt's tools wins silently, since re-declaring a prompt's own tool
   * inline is not a client error. Must run before `resolveAndMergeTools` so the
   * accumulation order is: inline → auto-attached (deduped against inline) →
   * `tool_refs`-resolved (deduped against both, throws on a real collision).
   *
   * @param req - The in-flight pipeline request; `tools` is mutated in place.
   * @param autoTools - The stored prompt version's resolved OpenAI tool defs (may be empty/undefined).
   */
  private mergeAutoAttachedTools(
    req: GatewayCompletionRequest,
    autoTools: ResolvedToolDefinition[] | undefined,
  ): void {
    if (!autoTools || autoTools.length === 0) return;
    const existingNames = new Set((req.tools ?? []).map((t) => t.function.name));
    const toAdd = autoTools.filter((t) => !existingNames.has(t.function.name));
    if (toAdd.length === 0) return;
    // ResolvedToolDefinition is structurally identical to ToolDefinition (both
    // OpenAI-shaped `{ type: 'function', function: { name, description?, parameters? } }`);
    // the cast documents that contract rather than widening an unrelated shape.
    req.tools = [...(req.tools ?? []), ...toAdd] as typeof req.tools;
  }

  /**
   * TC2 Task 5: resolves `req.tool_refs` (catalog references) into OpenAI tool
   * definitions and merges them with any inline `req.tools`, mutating `req` in
   * place. A name shared between an inline tool and a resolved ref is a 400 —
   * the model must never see two tool definitions for the same name. Always
   * strips `tool_refs` afterward so it never leaks to the provider adapter,
   * even when no refs were supplied.
   *
   * @param ctx - Call context; `ctx.teamId` scopes the catalog lookup.
   * @param req - The in-flight pipeline request; `tools`/`tool_refs` are mutated.
   * @throws {ValidationError} A `tool_ref` names a missing tool/alias/version, or
   *   an inline tool and a resolved ref share a function name.
   */
  private async resolveAndMergeTools(ctx: GatewayCallContext, req: GatewayCompletionRequest): Promise<void> {
    if (req.tool_refs && req.tool_refs.length > 0) {
      let resolved;
      try {
        resolved = await this.toolResolver.resolveRefs(ctx.teamId, req.tool_refs);
      } catch (err) {
        if (err instanceof ToolRefNotFoundError) throw new ValidationError(err.message);
        throw err;
      }
      const inline = req.tools ?? [];
      const inlineNames = new Set(inline.map((t) => t.function.name));
      for (const r of resolved) {
        if (inlineNames.has(r.function.name)) {
          throw new ValidationError(`Tool name '${r.function.name}' appears in both tools and tool_refs.`);
        }
      }
      // ResolvedToolDefinition is structurally identical to ToolDefinition (both
      // OpenAI-shaped `{ type: 'function', function: { name, description?, parameters? } }`);
      // the cast documents that contract rather than widening an unrelated shape.
      req.tools = [...inline, ...resolved] as typeof req.tools;
    }
    delete req.tool_refs; // never forward the ref field to the adapter
  }

  /**
   * Final `response_format` + `tools` guard, run AFTER every source of `tools`
   * has been merged onto `req` (inline, prompt-auto-attached via
   * {@link mergeAutoAttachedTools}, and `tool_refs`-resolved via
   * {@link resolveAndMergeTools}).
   *
   * The Zod `superRefine` on {@link ChatCompletionRequestSchema} only sees the
   * RAW request body, so it can catch inline `tools`/`tool_choice` alongside
   * `response_format` but is structurally blind to tools a stored prompt
   * attaches or a `tool_refs` lookup resolves — those don't exist until this
   * service runs. Without this check, a request shaped like
   * `{ prompt: { name, alias }, response_format: {...} }` where the prompt has
   * tools attached (or `{ tool_refs: [...], response_format: {...} }`) sails
   * through Zod, then `req.tools` gets populated post-validation, and reaches
   * the adapter with both fields set — which the Anthropic adapter resolves
   * by silently dropping every real tool in favor of the synthetic
   * response-format tool (see `anthropic.adapter.ts`).
   *
   * @param req - The in-flight pipeline request, after `resolveAndMergeTools` has run.
   * @throws {ValidationError} `response_format` is set and `req.tools` is a non-empty array.
   */
  private assertResponseFormatToolsCompatible(req: GatewayCompletionRequest): void {
    if (req.response_format !== undefined && req.tools !== undefined && req.tools.length > 0) {
      throw new ValidationError(
        'response_format cannot be combined with tools or tool_choice on the same request',
      );
    }
  }

  // Builds the per-deployment provider call: adapter chosen by the credential's
  // provider, decrypted credentials, and the request `model` rewritten to the
  // deployment's upstream model name.
  private buildInvoker(): DeploymentInvoker {
    return (d, r) => {
      const adapter = getAdapter(d.credential.provider);
      const creds: ProviderCredentials = {
        apiKey: decryptSecret(d.credential.secretCiphertext),
        baseUrl: connectionBaseUrl(d.credential.config),
      };
      return adapter.chatCompletion({ ...r, model: d.model.upstreamModel }, creds);
    };
  }

  /**
   * Rate-limit gate (G4): in-memory sliding window keyed by virtual key or team.
   * Records one request against the window; null/omitted limits = unlimited.
   * @returns The rate-limit key (for post-call TPM accounting) and remaining RPM headroom.
   * @throws {RateLimitedError} 429 when the RPM/TPM window is exhausted.
   */
  private enforceRateLimit(ctx: GatewayCallContext): { rlKey: string; remaining?: number } {
    const rlKey = ctx.virtualKeyId ?? ctx.teamId;
    const rl = checkAndRecord(rlKey, ctx.maxRpm ?? null, ctx.maxTpm ?? null, 0);
    if (!rl.ok) {
      throw new RateLimitedError('Rate limit exceeded.', rl.retryAfter);
    }
    return { rlKey, remaining: rl.remaining };
  }

  /**
   * Budget reserve (G4/G5 fix): lazy-resets each applicable budget, then
   * atomically reserves `estimatedCostUsd` against every one of them inside a
   * single transaction. If any budget can't fit the reservation, the whole
   * transaction rolls back — no partial reservation from this call survives —
   * and the request is rejected.
   *
   * This replaces the old check-then-act `precheckBudgets`, which read spend,
   * decided, and left the real increment for later (after the paid provider
   * call): a window where N concurrent requests could all read "under budget"
   * and all proceed before any of them committed spend. A single atomic
   * conditional increment per budget means only as many concurrent callers as
   * actually fit under the cap can ever succeed, no matter how many race in at
   * once.
   *
   * @param ctx - Team/virtual-key scope.
   * @param estimatedCostUsd - Conservative USD estimate to reserve (see `estimateRequestCostUsd`).
   * @returns Each applicable (freshly-reset) budget that was successfully reserved
   *   against. `reconcileBudgets` derives its own accurate before/after pair from
   *   `incrementSpend` at reconciliation time rather than from any spend value
   *   read here, since a snapshot taken before the reservation transaction runs
   *   goes stale the moment a concurrent request commits (see `reconcileBudgets`).
   * @throws {PaymentRequiredError} 402 BUDGET_EXCEEDED when a reservation would
   *   exceed a budget's cap.
   */
  private async reserveBudgets(ctx: GatewayCallContext, estimatedCostUsd: number): Promise<FreshBudget[]> {
    const applicable = await this.budgetsRepo.applicableBudgets(ctx.teamId, ctx.virtualKeyId);
    const rolled: FreshBudget[] = [];
    for (const b of applicable) {
      rolled.push(await this.budgetsRepo.resetIfElapsed(b));
    }

    return runInTransaction(async (tx) => {
      const reserved: FreshBudget[] = [];
      for (const b of rolled) {
        const result = await this.budgetsRepo.reserveSpend(tx, b.id, estimatedCostUsd);
        if (!result) {
          const scope = b.virtualKeyId ? 'Virtual key' : 'Team-wide';
          throw new PaymentRequiredError('BUDGET_EXCEEDED', `${scope} budget exceeded.`);
        }
        reserved.push(b);
      }
      return reserved;
    });
  }

  /**
   * Credits back the difference between the estimate `reserveBudgets`
   * reserved and the real cost now known — negative when the estimate
   * overshot, as it normally will, crediting the unused reservation back — and
   * detects any alert crossing using the before/after pair `incrementSpend`
   * itself returns for THIS reconciliation.
   *
   * This must NOT use `reserveBudgets`' `preSpendUsd` snapshot (Finding —
   * duplicate-alert bug): that value is read once, before the reservation
   * transaction even runs, and is shared by whichever concurrent requests
   * happened to reserve around the same moment. Under concurrency, two
   * requests crossing the same threshold would then both compare against the
   * same stale baseline and both detect a "crossing", sending two alert
   * emails for one real event. `incrementSpend`'s `before` (`after` minus
   * this call's own delta) is instead computed atomically inside the same
   * UPDATE that applies the correction, so it is always consistent with
   * whatever every other concurrent request has already committed — see the
   * doc comment on `BudgetsRepository.incrementSpend` for why a separately
   * read `before` is unsafe here.
   *
   * @param tx - Transaction client; call from inside the same tx as the request-row insert.
   * @param reserved - The budgets `reserveBudgets` returned (pre-reservation spend is no
   *   longer needed here — see above).
   * @param estimatedCostUsd - The estimate that was reserved per budget.
   * @param realCostUsd - The actual cost now known (0 on a fully failed call — credits back the whole reservation).
   * @returns Crossings this reconciliation caused, for post-commit alerting.
   */
  private async reconcileBudgets(
    tx: Prisma.TransactionClient,
    reserved: FreshBudget[],
    estimatedCostUsd: number,
    realCostUsd: number,
  ): Promise<{ budget: FreshBudget; crossing: BudgetCrossing; spendUsd: number }[]> {
    const delta = realCostUsd - estimatedCostUsd;
    const crossed: { budget: FreshBudget; crossing: BudgetCrossing; spendUsd: number }[] = [];
    for (const budget of reserved) {
      const t = await this.budgetsRepo.incrementSpend(tx, budget.id, delta);
      for (const crossing of detectBudgetCrossings({ before: t.before, after: t.after, limit: t.limit })) {
        crossed.push({ budget, crossing, spendUsd: Number(t.after) });
      }
    }
    return crossed;
  }

  /**
   * Mails the owners and admins about each budget alert one request crossed.
   *
   * Called **after** the money transaction commits, never inside it: a
   * rolled-back request must not have sent an alert, and an email enqueue has no
   * business holding a database transaction open. `notify()` swallows its own
   * failures, so nothing here can turn a recorded request into a failed one.
   *
   * @param crossings - One entry per (budget, alert) the increment produced.
   * @param teamId - Team the budgets belong to.
   */
  private async notifyBudgetCrossings(
    crossings: {
      budget: FreshBudget;
      crossing: BudgetCrossing;
      spendUsd: number;
    }[],
    teamId: string,
  ): Promise<void> {
    for (const { budget, crossing, spendUsd } of crossings) {
      const keyName = budget.virtualKeyId
        ? await this.budgetsRepo.findVirtualKeyName(budget.virtualKeyId)
        : null;
      const scopeLabel = budget.virtualKeyId
        ? `Virtual key "${keyName ?? 'unknown'}"`
        : 'Team-wide';

      const teamName = await this.budgetsRepo.findTeamName(teamId);
      const props = {
        teamName: teamName ?? 'your team',
        scopeLabel,
        period: budget.period as string,
        limitUsd: Number(budget.limitUsd),
        spendUsd,
        budgetsUrl: appLink('/gateway/budgets'),
      };

      await notify({
        teamId,
        // Spend is a billing concern, and editors/viewers cannot change a budget.
        category: 'budget_alerts',
        audience: { roles: ['owner', 'admin'] },
        // Two requests crossing simultaneously derive the same key and BullMQ
        // keeps one job. The period component means the next period, after
        // `resets_at` rolls forward, legitimately alerts again.
        dedupeKey: `budget:${budget.id}:${budgetPeriodKey(budget.resetsAt)}:${crossing}`,
        // Built per branch rather than with a ternary on `type`: the payload is a
        // discriminated union, and a union-typed `type` field cannot be correlated
        // with its `props` by the compiler.
        payload:
          crossing === 'threshold'
            ? { type: 'budget_threshold', props }
            : { type: 'budget_exhausted', props },
      });
    }
  }

  /**
   * Run one chat completion end to end and record a gateway_requests row.
   *
   * @param ctx - Team + auth context (teamId + actorId; virtual-key scope/limits in G3/G4).
   * @param req - Validated pipeline request (canonical body + optional `gateway` control).
   * @returns The normalized response plus metadata (provider, model, cost, requestId).
   * @throws {RateLimitedError} 429 RATE_LIMITED when the RPM/TPM window is exhausted (G4).
   * @throws {PaymentRequiredError} 402 BUDGET_EXCEEDED when an applicable spend cap is reached (G4).
   * @throws {AppError} 400 NO_CONNECTION when no connection can serve the model, or
   *   400 PROVIDER_BAD_REQUEST when the provider rejects the request.
   * @throws {BadGatewayError} 502 PROVIDER_ERROR when all candidate connections fail.
   * @throws {GatewayTimeoutError} 504 on a provider timeout.
   */
  async complete(ctx: GatewayCallContext, req: GatewayCompletionRequest, opts?: CompleteOptions): Promise<GatewayResult> {
    // 1. Validate — done at the controller boundary (Zod).

    // ── Stage 2b: prompt-reference render (lineage) ──────────────────────────
    // If the caller referenced a stored prompt instead of raw messages, resolve
    // it via Phase 1's engine, substitute the rendered messages, and capture the
    // exact version id to stamp on the request row. Throws NotFoundError (404),
    // MISSING_VARIABLES (400), or TEMPLATE_RENDER_ERROR (422) — all mapped by the
    // global error middleware, identical to Phase 1's render endpoint.
    let promptVersionId: string | null = null;
    let promptVariables: Record<string, unknown> | null = null;
    if (req.prompt) {
      promptVariables = (req.prompt.variables as Record<string, unknown> | undefined) ?? null;
      const rendered = await this.aliases.resolveAndRender(
        ctx.teamId,
        req.prompt.name,
        req.prompt.alias,
        req.prompt.variables,
      );
      // Roles were validated at version-commit time, so the widening cast is safe.
      req.messages = rendered.messages as ChatMessage[];
      promptVersionId = rendered.versionId;
      // #12: default the model to the version's bound model when the caller
      // omitted an explicit one. An explicit request `model` always wins.
      if (!req.model?.trim() && rendered.model) {
        req.model = rendered.model;
      }
      // TC3 Task 5: auto-attach the stored version's tools (inline wins on collision).
      this.mergeAutoAttachedTools(req, rendered.tools);
      delete req.prompt; // do not forward the ref to the provider adapter
    }

    // ── B1: render ad-hoc templated messages when the caller supplied variables ──
    // Mirrors the prompt-ref render (same nunjucks engine, same 422 on error) so an
    // edited/unsaved Playground experiment behaves identically to a stored prompt.
    // Skipped when a prompt ref already rendered (promptVersionId set) — that path
    // owns rendering; re-rendering here would double-render.
    if (!promptVersionId && req.messages && req.variables) {
      try {
        req.messages = await renderAdhocMessages(req.messages, req.variables);
      } catch (err) {
        if (err instanceof NunjucksRenderError) {
          throw new AppError(err.message, 422, 'TEMPLATE_RENDER_ERROR');
        }
        throw err;
      }
    }

    // ── TC2 Task 5: resolve catalog tool_refs and merge with inline tools ────────
    // Duplicate names (inline vs. resolved) are a 400. Always strips `tool_refs`
    // from `req` so it never leaks to the provider adapter.
    await this.resolveAndMergeTools(ctx, req);

    // Post-merge guard: the Zod layer only sees the raw body's inline `tools`/
    // `tool_choice`; prompt-auto-attached and tool_refs-resolved tools only
    // exist on `req` after the two merges above, so re-check here with the
    // fully-merged `tools` array.
    this.assertResponseFormatToolsCompatible(req);

    // #12: model may now arrive via the binding; the schema no longer requires it,
    // so enforce presence here (also covers ad-hoc calls that omit a model).
    if (!req.model?.trim()) {
      throw new ValidationError('model is required');
    }

    // ── Strip the gateway control field so the body stays OpenAI-compatible ──────
    const { gateway, prompt: _prompt, variables: _variables, tool_refs: _toolRefs, ...rest } = req;
    // After stage 2b (or validation) `messages` and `model` are guaranteed present.
    const normalized: NormalizedRequest = { ...rest, model: req.model!, messages: req.messages! };

    // 2. Scope check (model name) — runs before resolution so a scoped-out model
    // 403s regardless of the team's registry. Provider allow-list is checked after
    // resolution (below), once we know the deployment's provider.
    this.assertModelAllowed(ctx, normalized.model);

    // 4a. Rate limit — in-memory sliding window (process-local; Redis deferred, Q3).
    const { rlKey, remaining: rateLimitRemaining } = this.enforceRateLimit(ctx);

    // ── Stage 5: cache lookup ────────────────────────────────────────────────
    // Opt-in per virtual key (cacheTtlSeconds > 0), deterministic (temperature 0),
    // not bypassed by x-gateway-cache: no-store. teamId partitions the cache.
    const cacheable = this.isCacheable(ctx, normalized, opts);
    const cacheKey = cacheable ? computeCacheKey(ctx.teamId, normalized) : null;

    if (cacheable && cacheKey) {
      const lookupStart = Date.now();
      let hit: Awaited<ReturnType<CacheRepository['lookup']>> | undefined;
      try {
        hit = await this.cache.lookup(ctx.teamId, cacheKey);
      } catch (err) {
        // Cache failures must never break a call — log and fall through to live.
        console.warn('[gateway] cache lookup failed, falling through to provider', err);
        hit = undefined;
      }

      if (hit) {
        const latencyMs = Date.now() - lookupStart;
        // Record a cache_hit request row (tokens copied from cache; cost 0).
        // NO budget increment — do NOT open the G4 increment transaction here.
        const row = await this.gatewayRepo.recordRequest({
          teamId: ctx.teamId,
          virtualKeyId: ctx.virtualKeyId ?? null,
          providerConnectionId: null,
          provider: null,
          requestedModel: normalized.model,
          resolvedModel: hit.response.model,
          status: 'cache_hit',
          promptTokens: hit.promptTokens,
          completionTokens: hit.completionTokens,
          totalTokens: hit.promptTokens + hit.completionTokens,
          costUsd: 0,
          latencyMs,
          cacheHit: true,
          promptVersionId,
          errorCode: null,
        });

        const result: GatewayResult = {
          body: hit.response,
          provider: hit.response.model, // resolved model; provider label is optional on a hit
          model: hit.response.model,
          costUsd: 0,
          cacheHit: true,
          requestId: row.id,
        };

        // T1: cache hits also record a span (attributes.cacheHit=true). The
        // cache_hit ledger row was already committed by recordRequest above.
        const traced = await recordGatewaySpan({ ctx, result, request: req, gatewayRequestId: row.id, promptVariables });
        result.traceId = traced?.traceId;
        result.spanRef = traced?.spanRef;

        return result;
      }
    }

    // 6. Resolve the deployment chain from the model registry (primary + fallbacks).
    const deployments = await resolveDeployments(ctx.teamId, normalized.model);
    if (deployments.length === 0) {
      throw new AppError(
        `Model '${normalized.model}' is not registered. Add it under Gateway → Models.`,
        400,
        'MODEL_NOT_REGISTERED',
      );
    }

    // Provider allow-list (G3): now that we know the primary deployment's provider.
    this.assertProviderAllowed(ctx, deployments[0].credential.provider);

    // 4b. Budget reserve — durable spend caps in Postgres (G4/G5 fix). Lazy-reset
    // each applicable budget, then atomically reserve a conservative cost estimate
    // (priced at the primary deployment's rates) against every one, rejecting (402)
    // if any can't fit. Reserving here — after resolving deployments/pricing but
    // before the paid call — closes the concurrent-request race the old read-then-
    // increment-later check-then-act had. Reconciled to the real cost at step 9.
    const estimatedCostUsd = estimateRequestCostUsd(normalized, deployments[0].model);
    const reservedBudgets = await this.reserveBudgets(ctx, estimatedCostUsd);

    // Bind adapter + decrypted credentials + upstream-model rewrite per deployment.
    const invoke = this.buildInvoker();

    // 7. Call with retry/fallback; measure latency.
    const startedAt = Date.now();
    let served;
    try {
      served = await callWithFallback(deployments, normalized, invoke, {
        maxRetriesPerConn: gateway?.maxRetries ?? DEFAULT_MAX_RETRIES,
      });
    } catch (err) {
      // No real cost was incurred by ANY exception past this point — credit
      // back the full reservation unconditionally, before doing anything
      // error-type-specific, so a bug or an exception type other than
      // `FallbackExhaustedError` can never leak a permanently-consumed
      // reservation (that used to only happen in the `FallbackExhaustedError`
      // branch below, silently skipping every other exception type).
      if (reservedBudgets.length > 0) {
        await runInTransaction((tx) => this.reconcileBudgets(tx, reservedBudgets, estimatedCostUsd, 0));
      }

      if (err instanceof FallbackExhaustedError) {
        const latencyMs = Date.now() - startedAt;
        // Still record an error row (cost 0) so failures show up in analytics.
        await this.gatewayRepo.recordRequest({
          teamId: ctx.teamId,
          virtualKeyId: ctx.virtualKeyId ?? null,
          providerConnectionId: err.lastDeployment?.credential.id ?? null,
          gatewayModelId: err.lastDeployment?.model.id ?? null,
          provider: err.lastDeployment?.credential.provider ?? null,
          requestedModel: normalized.model,
          resolvedModel: null,
          status: 'error',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs,
          cacheHit: false,
          promptVersionId,
          errorCode: err.lastError.providerCode ?? String(err.lastError.status),
          meta: { attempts: err.meta.attempts, trail: err.meta.trail },
        });
        throw this.mapProviderError(err.lastError);
      }
      throw err;
    }
    const latencyMs = Date.now() - startedAt;
    const response = served.response;
    const servedDeployment = served.deployment;

    // 8. Compute cost from the served deployment's stored prices + provider usage.
    const costUsd = computeCostFromPrices(
      servedDeployment.model.inputPricePerM,
      servedDeployment.model.outputPricePerM,
      response.usage,
    );
    if (costUsd === null) {
      console.warn(`[gateway] no pricing for model '${normalized.model}'; cost recorded as null`);
    }

    // 9. Persist the success row and increment every applicable budget in ONE
    // transaction so cost accounting is atomic. cacheHit and null-cost calls add 0.
    // provider_connection_id = the connection that SERVED the request; meta = the trail.
    const cacheHit = false; // ← G6 cache sets this true on a cache hit
    const spendDelta = cacheHit ? 0 : costUsd ?? 0;
    const crossed: { budget: FreshBudget; crossing: BudgetCrossing; spendUsd: number }[] = [];
    const row = await runInTransaction(async (tx) => {
      const created = await this.gatewayRepo.recordRequest(
        {
          teamId: ctx.teamId,
          virtualKeyId: ctx.virtualKeyId ?? null,
          providerConnectionId: servedDeployment.credential.id, // served credential
          gatewayModelId: servedDeployment.model.id, // served registered model
          provider: servedDeployment.credential.provider,
          requestedModel: normalized.model,
          resolvedModel: response.model || servedDeployment.model.upstreamModel,
          status: 'success',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          costUsd,
          latencyMs,
          cacheHit,
          promptVersionId, // ← G8 lineage
          meta: { attempts: served.meta.attempts, trail: served.meta.trail }, // ← G5
        },
        tx,
      );
      if (reservedBudgets.length > 0) {
        // Collected, not sent: this is still inside the transaction, which may
        // yet roll back. Sending happens after the commit below. Reconciles to
        // the real cost regardless of spendDelta — the reservation above may
        // have added a non-zero estimate even when the real cost is 0/null.
        crossed.push(...(await this.reconcileBudgets(tx, reservedBudgets, estimatedCostUsd, spendDelta)));
      }
      return created;
    });

    if (crossed.length > 0) await this.notifyBudgetCrossings(crossed, ctx.teamId);

    // Fold real token usage into the RPM/TPM window post-call (TPM accounting).
    recordTokens(rlKey, response.usage.total_tokens ?? 0);

    // ── Store into cache (after a successful live call) ──────────────────────
    // Awaited (not fire-and-forget) so a subsequent identical request
    // deterministically hits; wrapped so a cache write never fails the call.
    if (cacheable && cacheKey) {
      try {
        await this.cache.store(ctx.teamId, cacheKey, response, response.usage, ctx.cacheTtlSeconds!);
      } catch (err) {
        console.warn('[gateway] cache store failed (non-fatal)', err);
      }
    }

    // 10. Return the OpenAI-shaped body + metadata for headers.
    const result: GatewayResult = {
      body: response,
      provider: servedDeployment.credential.provider,
      model: response.model || servedDeployment.model.upstreamModel,
      costUsd,
      cacheHit,
      requestId: row.id,
      rateLimitRemaining,
    };

    // T1: mirror the committed ledger row into a span — AFTER the money tx
    // committed, best-effort (the hook owns its own tx and never rethrows).
    const traced = await recordGatewaySpan({ ctx, result, request: req, gatewayRequestId: row.id, promptVariables });
    result.traceId = traced?.traceId;
    result.spanRef = traced?.spanRef;

    return result;
  }

  /**
   * Streaming sibling of {@link GatewayService.complete}. Runs the full pre-call
   * pipeline (scope → rate-limit → budget pre-check), resolves candidate
   * connections, opens the provider stream with fallback (selection only, before
   * the first byte), buffers the first chunk, and returns a {@link GatewayStream}.
   * Cache (G6) is skipped entirely for streams.
   *
   * @param ctx - Auth/scope/limit context from gateway-auth middleware or session.
   * @param req - Validated pipeline request with `stream === true`.
   * @returns A handle whose `chunks` generator yields normalized frames and whose
   *   `finalize` records the request row + budget increment on stream end.
   * @throws {ForbiddenError} A scoped-out model/provider (no stream opened).
   * @throws {PaymentRequiredError} A budget is already exceeded (no stream opened).
   * @throws {RateLimitedError} RPM/TPM exceeded (no stream opened).
   * @throws {AppError} 400 NO_CONNECTION when no connection can serve the model.
   * @throws {BadGatewayError} Every candidate provider failed before the first chunk.
   */
  async completeStream(
    ctx: GatewayCallContext,
    req: GatewayCompletionRequest,
    _opts?: CompleteOptions,
  ): Promise<GatewayStream> {
    const requestId = randomUUID();
    const startedAt = Date.now();

    // Stage 2b: prompt-reference render (lineage) — mirror of the non-streaming path.
    let promptVersionId: string | null = null;
    // Captured before `delete req.prompt` below, so the trace span can store the raw
    // variables alongside the rendered messages (mirror of complete()).
    let promptVariables: Record<string, unknown> | null = null;
    if (req.prompt) {
      promptVariables = (req.prompt.variables as Record<string, unknown> | undefined) ?? null;
      const rendered = await this.aliases.resolveAndRender(
        ctx.teamId,
        req.prompt.name,
        req.prompt.alias,
        req.prompt.variables,
      );
      req.messages = rendered.messages as ChatMessage[];
      promptVersionId = rendered.versionId;
      // #12: default the model to the version's bound model when omitted (mirror
      // of complete()); an explicit request `model` always wins.
      if (!req.model?.trim() && rendered.model) {
        req.model = rendered.model;
      }
      // TC3 Task 5: auto-attach the stored version's tools (inline wins on collision).
      this.mergeAutoAttachedTools(req, rendered.tools);
      delete req.prompt;
    }

    // ── B1: render ad-hoc templated messages when the caller supplied variables ──
    // Mirror of the non-streaming path (see complete()) — skipped when a prompt ref
    // already rendered (promptVersionId set), to avoid double-rendering.
    if (!promptVersionId && req.messages && req.variables) {
      try {
        req.messages = await renderAdhocMessages(req.messages, req.variables);
      } catch (err) {
        if (err instanceof NunjucksRenderError) {
          throw new AppError(err.message, 422, 'TEMPLATE_RENDER_ERROR');
        }
        throw err;
      }
    }

    // TC2 Task 5: resolve catalog tool_refs and merge with inline tools (mirrors
    // the non-streaming path above — same 400 on a name collision).
    await this.resolveAndMergeTools(ctx, req);

    // Post-merge guard: mirror of complete() — re-check with the fully-merged
    // `tools` array, since prompt-auto-attached/tool_refs-resolved tools are
    // invisible to the Zod-layer check on the raw body.
    this.assertResponseFormatToolsCompatible(req);

    // #12: enforce model presence (schema no longer requires it — may come from
    // the binding or be absent on an ad-hoc call). Mirror of complete().
    if (!req.model?.trim()) {
      throw new ValidationError('model is required');
    }

    // Strip the gateway control field so the body stays OpenAI-compatible.
    const { gateway: _gateway, prompt: _prompt, variables: _variables, tool_refs: _toolRefs, ...rest } = req;
    const normalized: NormalizedRequest = { ...rest, model: req.model!, messages: req.messages! };

    // 2 + 4a: full pre-call pipeline (throws before any stream is opened).
    this.assertModelAllowed(ctx, normalized.model);
    const { rlKey, remaining: _remaining } = this.enforceRateLimit(ctx);

    // 5. Cache: SKIPPED for streams (G6 v1).

    // 6. Resolve the deployment chain from the model registry.
    const deployments = await resolveDeployments(ctx.teamId, normalized.model);
    if (deployments.length === 0) {
      throw new AppError(
        `Model '${normalized.model}' is not registered. Add it under Gateway → Models.`,
        400,
        'MODEL_NOT_REGISTERED',
      );
    }
    this.assertProviderAllowed(ctx, deployments[0].credential.provider);

    // 4b. Budget reserve (G4/G5 fix, mirrors complete() — see its comment).
    // Reserving before the deployment-fallback loop below means a budget that
    // can't fit the reservation throws here, before any provider stream opens.
    const estimatedCostUsd = estimateRequestCostUsd(normalized, deployments[0].model);
    const reservedBudgets = await this.reserveBudgets(ctx, estimatedCostUsd);

    // 7 (selection). Try deployments in order until one yields a first chunk.
    // Fallback ends the moment a byte is committed — after the first chunk the
    // stream is bound to the selected deployment. The request model is rewritten
    // to the deployment's upstream name for each attempt.
    const abortController = new AbortController();
    let selected: ResolvedDeployment | null = null;
    let iterator: AsyncIterator<StreamChunk> | null = null;
    let firstChunk: IteratorResult<StreamChunk> | null = null;

    for (const deployment of deployments) {
      try {
        const creds: ProviderCredentials = {
          apiKey: decryptSecret(deployment.credential.secretCiphertext),
          baseUrl: connectionBaseUrl(deployment.credential.config),
        };
        const adapter = getAdapter(deployment.credential.provider);
        const upstreamReq: NormalizedRequest = { ...normalized, model: deployment.model.upstreamModel };
        const it = adapter.streamChatCompletion(upstreamReq, creds, abortController.signal)[Symbol.asyncIterator]();
        const first = await it.next(); // may throw ProviderError before the first chunk
        selected = deployment;
        iterator = it;
        firstChunk = first;
        break;
      } catch (err) {
        if (!(err instanceof ProviderError)) {
          // A real bug (never swallowed) aborts the whole request with no
          // real cost incurred — credit back the full reservation before
          // rethrowing. Without this, only a `ProviderError` on every
          // deployment reached the `recordStreamRow` credit-back below (via
          // the `!selected` branch); any OTHER exception type propagated out
          // of `completeStream` directly, permanently leaking the reservation
          // `reserveBudgets` took above.
          if (reservedBudgets.length > 0) {
            await runInTransaction((tx) =>
              this.reconcileBudgets(tx, reservedBudgets, estimatedCostUsd, 0),
            );
          }
          throw err;
        }
        // Nothing sent yet → fall through to the next deployment.
        continue;
      }
    }

    if (!selected || !iterator || !firstChunk) {
      // Record a failure row (status 'error' credits the reservation back in
      // full, no real cost — see recordStreamRow) then surface a JSON 502.
      await this.recordStreamRow({
        requestId,
        ctx,
        requestedModel: normalized.model,
        provider: deployments[0] ? deployments[0].credential.provider : null,
        providerConnectionId: deployments[0]?.credential.id ?? null,
        gatewayModelId: deployments[0]?.model.id ?? null,
        resolvedModel: null,
        status: 'error',
        errorCode: 'PROVIDER_ERROR',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        latencyMs: Date.now() - startedAt,
        meta: {},
        reservedBudgets,
        estimatedCostUsd,
        promptVersionId,
      });
      throw new BadGatewayError('All providers failed before streaming started.');
    }

    const resolvedModel = selected.model.upstreamModel;
    const provider = selected.credential.provider;
    const providerConnectionId = selected.credential.id;
    const gatewayModelId = selected.model.id;
    const selectedModel = selected.model;

    // Accumulators shared between the generator and finalize().
    let accumulatedText = '';
    let providerUsage: Usage | undefined;
    let finishReason: string | null = null;
    let finalized = false;
    // Tool-call fragments, keyed by the wire `index` that correlates them across
    // frames. A streamed turn never yields a whole message, so without this the
    // trace payload for a tool-calling turn would record an empty output.
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

    // T1: minted BEFORE the first chunk so the controller can flush
    // x-gateway-trace-id / x-gateway-span-id, even though the span itself is only
    // written once `finalize` knows the usage and cost.
    const traceId = ctx.traceId ?? randomUUID();
    const spanRef = randomUUID();

    const committedIterator = iterator;
    const committedFirst = firstChunk;

    async function* streamBody(): AsyncGenerator<StreamChunk> {
      try {
        for (
          let step: IteratorResult<StreamChunk> = committedFirst;
          !step.done;
          step = await committedIterator.next()
        ) {
          const chunk = step.value;
          accumulatedText += chunk.delta;
          if (chunk.finish_reason !== null) finishReason = chunk.finish_reason;
          if (chunk.usage) providerUsage = chunk.usage;
          for (const tc of chunk.tool_calls ?? []) {
            const key = tc.index ?? 0;
            const part = toolCallParts.get(key) ?? { id: '', name: '', arguments: '' };
            if (tc.id) part.id = tc.id;
            if (tc.function.name) part.name = tc.function.name;
            part.arguments += tc.function.arguments;
            toolCallParts.set(key, part);
          }
          yield chunk;
        }
      } finally {
        // Consumer stopped early → tear down the provider stream.
        if (committedIterator.return) await committedIterator.return().catch(() => undefined);
      }
    }

    const recordStreamRow = this.recordStreamRow.bind(this);
    const finalize = async (opts: FinalizeStreamOpts): Promise<void> => {
      if (finalized) return;
      finalized = true;

      let promptTokens: number;
      let completionTokens: number;
      let usageEstimated = false;

      if (providerUsage) {
        promptTokens = providerUsage.prompt_tokens;
        completionTokens = providerUsage.completion_tokens;
      } else {
        promptTokens = estimateTokens(normalized.messages, resolvedModel);
        completionTokens = estimateTokens(accumulatedText, resolvedModel);
        usageEstimated = true;
      }
      const usage: Usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      const costUsd = computeCostFromPrices(
        selectedModel.inputPricePerM,
        selectedModel.outputPricePerM,
        usage,
      ); // null if the served model is unpriced

      const meta: Record<string, unknown> = {};
      if (usageEstimated) meta['usageEstimated'] = true;
      if (opts.clientAborted) meta['clientAborted'] = true;
      if (finishReason) meta['finishReason'] = finishReason;

      // Fold usage into the RPM/TPM window post-call (TPM accounting).
      recordTokens(rlKey, usage.total_tokens);

      await recordStreamRow({
        requestId,
        ctx,
        requestedModel: normalized.model,
        provider,
        providerConnectionId,
        gatewayModelId,
        resolvedModel,
        status: opts.status,
        errorCode: opts.status === 'error' ? opts.errorCode ?? 'PROVIDER_ERROR' : null,
        promptTokens,
        completionTokens,
        costUsd,
        latencyMs: Date.now() - startedAt,
        meta,
        reservedBudgets,
        estimatedCostUsd,
        promptVersionId,
      });

      // T1: mirror the committed ledger row into a span, exactly as `complete()`
      // does — AFTER the money row commits, best-effort, never rethrowing. The
      // streamed reply is reassembled into an OpenAI-shaped body so the span
      // payload reads the same as a non-streamed one.
      const assembled: ToolCall[] = [...toolCallParts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, p]) => ({ id: p.id, type: 'function' as const, function: { name: p.name, arguments: p.arguments } }));
      await recordGatewaySpan({
        ctx: { ...ctx, traceId },
        result: {
          body: {
            id: `chatcmpl-${requestId}`,
            object: 'chat.completion',
            created: Math.floor(startedAt / 1000),
            model: resolvedModel,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant' as const,
                  content: accumulatedText,
                  ...(assembled.length ? { tool_calls: assembled } : {}),
                },
                finish_reason: finishReason,
              },
            ],
            usage,
          },
          provider,
          model: resolvedModel,
          costUsd,
          cacheHit: false,
          requestId,
        },
        request: req,
        gatewayRequestId: requestId,
        promptVariables: promptVariables ?? null,
        spanRef,
      });
    };

    return {
      requestId,
      provider,
      resolvedModel,
      providerConnectionId,
      traceId,
      spanRef,
      chunks: streamBody(),
      finalize,
      abort: () => abortController.abort(),
    };
  }

  /**
   * Insert one gateway_requests row and reconcile every reserved budget's
   * estimate to the real cost, in a single transaction (mirrors `complete()`'s
   * persist stage, G4/G5). An 'error' status reconciles to a real cost of 0 —
   * crediting the reservation back in full, since no cost was incurred.
   */
  private async recordStreamRow(p: {
    requestId: string;
    ctx: GatewayCallContext;
    requestedModel: string;
    provider: string | null;
    providerConnectionId: string | null;
    gatewayModelId: string | null;
    resolvedModel: string | null;
    status: 'success' | 'error';
    errorCode: string | null;
    promptTokens: number;
    completionTokens: number;
    costUsd: number | null;
    latencyMs: number;
    meta: Record<string, unknown>;
    reservedBudgets: FreshBudget[];
    estimatedCostUsd: number;
    promptVersionId: string | null;
  }): Promise<void> {
    const realCostUsd = p.status === 'error' ? 0 : p.costUsd ?? 0;
    const crossed: { budget: FreshBudget; crossing: BudgetCrossing; spendUsd: number }[] = [];
    await runInTransaction(async (tx) => {
      await this.gatewayRepo.recordRequest(
        {
          id: p.requestId,
          teamId: p.ctx.teamId,
          virtualKeyId: p.ctx.virtualKeyId ?? null,
          providerConnectionId: p.providerConnectionId,
          gatewayModelId: p.gatewayModelId,
          provider: p.provider,
          requestedModel: p.requestedModel,
          resolvedModel: p.resolvedModel,
          status: p.status,
          promptTokens: p.promptTokens,
          completionTokens: p.completionTokens,
          totalTokens: p.promptTokens + p.completionTokens,
          costUsd: p.costUsd,
          latencyMs: p.latencyMs,
          cacheHit: false,
          promptVersionId: p.promptVersionId,
          errorCode: p.errorCode,
          meta: p.meta,
        },
        tx,
      );
      if (p.reservedBudgets.length > 0) {
        crossed.push(
          ...(await this.reconcileBudgets(tx, p.reservedBudgets, p.estimatedCostUsd, realCostUsd)),
        );
      }
    });

    // Streaming spend is settled here, once the stream has finished, so this is
    // the streaming path's equivalent of `complete()`'s post-commit alert.
    if (crossed.length > 0) await this.notifyBudgetCrossings(crossed, p.ctx.teamId);
  }

  /**
   * Map a terminal provider error (from `callWithFallback`) to the caller-facing HTTP error.
   *
   * @param err - The last provider error carried by `FallbackExhaustedError`.
   * @returns 400 PROVIDER_BAD_REQUEST for a provider 400 (caller's fault); 504
   *   PROVIDER_TIMEOUT for a 504/408; else 502 PROVIDER_ERROR.
   */
  private mapProviderError(err: ProviderError): AppError {
    if (err.status === 400) {
      return new AppError(
        `Provider rejected the request (400): ${err.message}`,
        400,
        'PROVIDER_BAD_REQUEST',
      );
    }
    if (err.status === 504 || err.status === 408) {
      return new GatewayTimeoutError();
    }
    return new BadGatewayError(`Provider error (${err.status}): ${err.message}`);
  }
}
