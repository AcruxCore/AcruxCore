import type { ProviderConnection } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ConnectionsRepository } from '../connections/connections.repository';
import { decryptStoredSecret } from '../connections/crypto';
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
import { VersionsRepository as PromptVersionsRepository } from '../../prompts/versions/versions.repository';
import { renderMessages, NunjucksRenderError } from '../../prompts/versions/nunjucks.utils';
// Imported from the concrete sub-barrel, not the top-level `../../tools` barrel:
// that barrel also re-exports `toolsRouter`, which pulls in Express as a load-time
// side effect (same Express-free-graph concern as the `AliasesService` import above).
import { ToolResolver, ToolRefNotFoundError } from '../../tools/resolver';
import type { ResolvedToolDefinition } from '../../tools/resolver';
import { randomUUID } from 'node:crypto';
import { resolveDeployments, callWithFallback, FallbackExhaustedError } from './router';
import type { DeploymentInvoker, FallbackTrailEntry, ResolvedDeployment } from './router';
import type { GatewayCallContext, GatewayCompletionRequest, GatewayResult } from './completions.types';
import { CacheRepository } from '../cache/cache.repository';
import { computeCacheKey } from '../cache/cache-key';
import { recordGatewaySpan, recordGatewayErrorSpan } from '../../traces/ingest/gateway-trace.hook';
import {
  AppError,
  BadGatewayError,
  ProviderRateLimitedError,
  GatewayTimeoutError,
  ForbiddenError,
  PaymentRequiredError,
  RateLimitedError,
  ValidationError,
} from '../../shared/errors';
import { runInTransaction } from '../../shared/db/unit-of-work';

/**
 * Provider 4xx statuses whose body describes the CALLER's request, so forwarding it helps.
 *
 * Deliberately not "every 4xx". A 401/403 body is about the team's stored credential — and
 * a provider 401 can echo a masked copy of the key it was sent — while a 429 is about the
 * team's quota. Neither is something the caller of this gateway can act on, so both stay
 * flattened. 400 is handled separately, above this set, because it always forwards.
 */
const REQUEST_FAULT_STATUSES = new Set([404, 413, 422]);

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
 * One budget alert a single spend transition crossed.
 *
 * Three things produce these: the reservation, the reconciliation, and a *rejected*
 * reservation. All of them feed the same `notifyBudgetCrossings` after their
 * transaction has settled.
 */
interface BudgetCrossingRecord {
  budget: FreshBudget;
  crossing: BudgetCrossing;
  spendUsd: number;
}

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
  /** Verifies a client-supplied `prompt_version_id` belongs to the calling team. */
  private readonly promptVersions = new PromptVersionsRepository();

  constructor(
    private readonly gatewayRepo: GatewayRepository,
    private readonly connectionsRepo: ConnectionsRepository,
    private readonly budgetsRepo: BudgetsRepository = new BudgetsRepository(),
  ) {}

  /**
   * Verifies a caller-supplied `prompt_version_id` and returns it, or null when none was
   * sent. Always strips the field from `req` so it cannot reach a provider adapter.
   *
   * Exists because a client that renders a prompt itself — every SDK tool loop does, and
   * so does anything holding a cached render — otherwise has no way to tell us which
   * version those messages came from, and its `llm` spans lose prompt lineage while the
   * call still succeeds. The `prompt` reference path needs none of this: it renders here,
   * so it already knows.
   *
   * @param ctx - The call context, for the team the id must belong to.
   * @param req - The in-flight request; `prompt_version_id` is deleted off it.
   * @param alreadyResolved - The version a `prompt` reference resolved to, if any. When
   *   set, the caller's id is ignored — server-side rendering is the better source.
   * @returns The verified version id, or null.
   * @throws {ValidationError} The id names no prompt version in this team. A 400 rather
   *   than a silent drop, because a caller who sent an id is asking for lineage and
   *   would otherwise never learn it was thrown away.
   */
  private async resolveClientPromptVersionId(
    ctx: GatewayCallContext,
    req: GatewayCompletionRequest,
    alreadyResolved: string | null,
  ): Promise<string | null> {
    const supplied = req.prompt_version_id;
    delete req.prompt_version_id;
    if (alreadyResolved || !supplied) return alreadyResolved;

    const version = await this.promptVersions.findByIdForTeam(supplied, ctx.teamId);
    if (!version) {
      throw new ValidationError(
        `prompt_version_id '${supplied}' is not a prompt version in this team.`,
      );
    }
    return version.id;
  }

  /**
   * The variables to store on this call's `llm` span payload.
   *
   * `variables` carries two jobs that are easy to conflate. It is a *render input*,
   * which only matters when the gateway does the rendering; and it is *replay
   * lineage* — the pre-render values an evaluation re-renders a candidate template
   * against — which matters whenever a prompt version is named, no matter who
   * rendered. A client-rendered call (`messages` + `prompt_version_id` +
   * `variables`) gives us nothing to render, but its variables are still the only
   * replay lineage that exists. Dropping them left the span with a version id and
   * null variables, which is permanently ineligible as a dataset example — the
   * caller had supplied exactly what the build said was missing (#412).
   *
   * A `prompt` reference can never arrive with top-level `variables` (the schema's
   * superRefine rejects that pair), so the two sources never compete.
   *
   * @param req - The in-flight request, read before `variables` is stripped for the adapter.
   * @param fromPromptRef - Variables taken off a `prompt` reference, when it was one.
   * @returns The variables to write to `span_payloads.variables`, or null when the
   *   caller sent none.
   */
  private replayVariables(
    req: GatewayCompletionRequest,
    fromPromptRef: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    return fromPromptRef ?? (req.variables as Record<string, unknown> | undefined) ?? null;
  }

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
   * Applies **both** of the virtual key's allow-lists — provider and model — to an
   * entire fallback chain.
   *
   * Each allow-list used to be checked against the caller's request only: the provider
   * against `deployments[0]`, the model against the requested name. But
   * `callWithFallback` walks every deployment, and each fallback carries its own
   * credential *and* its own registered public name — so as soon as the primary failed,
   * the request could be served by a provider or a model the key forbids. That turned
   * two governance controls ("never send my prompts to provider X", "this key may only
   * use the cheap model") into controls that held only while the primary was healthy. A
   * key scoped to `fast`, whose fallback is `fast-backup`, silently billed the expensive
   * model on every primary 429.
   *
   * The primary still throws, so a caller asking for something it may not use gets the
   * same 403 as before. Fallbacks are filtered out instead: the chain is the team's
   * configuration rather than anything this caller asked for, so a forbidden link is
   * skipped, not an error.
   *
   * @param ctx - The call context carrying the key's `allowedProviders`/`allowedModels`.
   * @param deployments - The resolved chain, primary first.
   * @returns The chain with forbidden fallbacks removed. The primary is always still
   *   first, because a forbidden primary throws rather than being filtered out.
   * @throws {ForbiddenError} PROVIDER_NOT_ALLOWED / MODEL_NOT_ALLOWED when the
   *   *primary* is forbidden.
   */
  private scopeDeploymentsToKey<
    T extends { model: { publicName: string }; credential: { provider: string } },
  >(ctx: GatewayCallContext, deployments: T[]): T[] {
    this.assertProviderAllowed(ctx, deployments[0].credential.provider);
    this.assertModelAllowed(ctx, deployments[0].model.publicName);

    const providers =
      ctx.allowedProviders && ctx.allowedProviders.length > 0 ? new Set(ctx.allowedProviders) : undefined;
    const models =
      ctx.allowedModels && ctx.allowedModels.length > 0 ? new Set(ctx.allowedModels) : undefined;
    if (!providers && !models) return deployments;

    return deployments.filter(
      (d) =>
        (!providers || providers.has(d.credential.provider)) &&
        (!models || models.has(d.model.publicName)),
    );
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
        apiKey: decryptStoredSecret(d.credential.secretCiphertext, 'provider_credential', d.credential.label),
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
   * A rejected reservation is also the only place a `budget_exhausted` alert can come
   * from. `detectBudgetCrossings` needs `after >= limit`, and a reservation only ever
   * commits when `spend + delta <= limit`, so a *successful* reservation could satisfy
   * both only by landing exactly on the cap — which against `Decimal(18,9)` dollars
   * does not happen. The transition that actually cuts a team off is the one where the
   * conditional `UPDATE` matches no row, so the alert is raised from here, after the
   * transaction has rolled back.
   *
   * @param ctx - Team/virtual-key scope.
   * @param estimatedCostUsd - Conservative USD estimate to reserve (see `estimateRequestCostUsd`).
   * @returns Each applicable (freshly-reset) budget that was successfully reserved
   *   against, plus any alert the reservation itself crossed. `reconcileBudgets`
   *   derives its own before/after pair from `incrementSpend` at reconciliation time
   *   rather than from any spend value read here, since a snapshot taken before the
   *   reservation transaction runs goes stale the moment a concurrent request commits.
   * @throws {PaymentRequiredError} 402 BUDGET_EXCEEDED when a reservation would
   *   exceed a budget's cap.
   */
  private async reserveBudgets(
    ctx: GatewayCallContext,
    estimatedCostUsd: number,
  ): Promise<{ reserved: FreshBudget[]; crossed: BudgetCrossingRecord[] }> {
    const applicable = await this.budgetsRepo.applicableBudgets(ctx.teamId, ctx.virtualKeyId);
    const rolled: FreshBudget[] = [];
    for (const b of applicable) {
      rolled.push(await this.budgetsRepo.resetIfElapsed(b));
    }

    let exhausted: FreshBudget | undefined;
    try {
      return await runInTransaction(async (tx) => {
        const reserved: FreshBudget[] = [];
        const crossed: BudgetCrossingRecord[] = [];
        for (const b of rolled) {
          const result = await this.budgetsRepo.reserveSpend(tx, b.id, estimatedCostUsd);
          if (!result) {
            exhausted = b;
            const scope = b.virtualKeyId ? 'Virtual key' : 'Team-wide';
            throw new PaymentRequiredError('BUDGET_EXCEEDED', `${scope} budget exceeded.`);
          }
          // The reservation is the only step that reliably raises spend —
          // reconciliation normally credits an overestimate back, so its delta is
          // negative and `detectBudgetCrossings` (which needs before < line <= after)
          // could never fire on it. Detecting here is what makes the warning
          // reachable at all; reconciliation still detects too, for the case where
          // the real cost overshot the estimate.
          crossed.push(
            ...detectBudgetCrossings({ before: result.before, after: result.after, limit: result.limit })
              .map((crossing) => ({ budget: b, crossing, spendUsd: Number(result.after) })),
          );
          reserved.push(b);
        }
        return { reserved, crossed };
      });
    } catch (err) {
      // Raised out here, where the transaction has already rolled back, so the alert
      // describes a 402 the caller is genuinely about to receive. Every later blocked
      // request in the same period derives the same dedupe key and folds into this
      // one job, so a team gets one "cut off" email per period, not one per request.
      if (exhausted) {
        await this.notifyBudgetCrossings(
          [{ budget: exhausted, crossing: 'exhausted', spendUsd: Number(exhausted.spendUsd) }],
          ctx.teamId,
          ctx.contributingSource,
        );
      }
      throw err;
    }
  }

  /**
   * Credits back the difference between the estimate `reserveBudgets`
   * reserved and the real cost now known — negative when the estimate
   * overshot, as it normally will, crediting the unused reservation back — and
   * detects any alert crossing using the before/after pair `incrementSpend`
   * itself returns for THIS reconciliation.
   *
   * Detection runs on the before/after pair `incrementSpend` returns for THIS
   * correction, and on nothing else. Every write to the row — each reservation, each
   * reconciliation — returns a transition computed atomically inside its own UPDATE,
   * so consecutive transitions tile the row's trajectory without gaps or overlap and
   * any given line is crossed by exactly one of them. That tiling is what makes
   * "exactly one alert" hold under concurrency, and it is why no baseline read
   * earlier may be substituted here.
   *
   * Two such baselines have been tried and both break it. `preSpendUsd` was read
   * once outside any transaction and shared by whichever requests reserved around the
   * same moment, so two of them compared against one stale value and both "crossed".
   * Carrying each request's own reservation `before` forward fails differently but
   * just as surely: by the time it reconciles, other requests have committed in
   * between, so its pair overlaps theirs and a line gets crossed twice. Only the
   * atomic pair is disjoint.
   *
   * @param tx - Transaction client; call from inside the same tx as the request-row insert.
   * @param reserved - The budgets `reserveBudgets` returned.
   * @param estimatedCostUsd - The estimate that was reserved per budget.
   * @param realCostUsd - The actual cost now known (0 on a fully failed call — credits back the whole reservation).
   * @returns Crossings this reconciliation caused, for post-commit alerting.
   */
  private async reconcileBudgets(
    tx: Prisma.TransactionClient,
    reserved: FreshBudget[],
    estimatedCostUsd: number,
    realCostUsd: number,
  ): Promise<BudgetCrossingRecord[]> {
    const delta = realCostUsd - estimatedCostUsd;
    const crossed: BudgetCrossingRecord[] = [];
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
   * business holding a database transaction open.
   *
   * It must therefore not reject, and every iteration is guarded to guarantee that.
   * `notify()` swallows its own failures, but the two name lookups around it do not,
   * and the streaming caller reads *any* rejection from this point on as "the ledger
   * row was never written" and credits the reservation back — a second time, after
   * reconciliation has already done it. A pool blip while fetching a team name would
   * then leave the team's recorded spend below the truth for the rest of the period,
   * which is the defect issue #488 was filed for, reached through a new door.
   *
   * @param crossings - One entry per (budget, alert) the increment produced.
   * @param teamId - Team the budgets belong to.
   * @param contributingSource - Set when the call that caused this crossing was
   *   made on behalf of an internal caller (e.g. an online-eval judge run), so the
   *   `budget_exhausted` email can name what contributed to the spend.
   */
  private async notifyBudgetCrossings(
    crossings: {
      budget: FreshBudget;
      crossing: BudgetCrossing;
      spendUsd: number;
    }[],
    teamId: string,
    contributingSource?: string,
  ): Promise<void> {
    for (const { budget, crossing, spendUsd } of crossings) {
      try {
      const keyName = budget.virtualKeyId
        ? await this.budgetsRepo.findVirtualKeyName(budget.virtualKeyId, teamId)
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
        contributingSource,
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
      } catch (err) {
        // Log and move to the next crossing. The spend itself is recorded correctly
        // either way; a missing alert email is much the smaller failure.
        console.error('[budget alert] failed to enqueue', { budgetId: budget.id, crossing }, err);
      }
    }
  }

  /**
   * The connections in a fallback trail that the gateway refused to call,
   * deduplicated — one chain can try the same connection under two registered
   * models.
   *
   * @param trail - The attempt trail `callWithFallback` built.
   * @returns One entry per distinct refused connection, with the guard's own
   *   explanation. Empty for the overwhelming majority of calls.
   */
  private blockedConnectionsIn(
    trail: FallbackTrailEntry[],
  ): { credentialId: string; reason: string }[] {
    const byId = new Map<string, string>();
    for (const entry of trail) {
      if (entry.blockedAddress && !byId.has(entry.credentialId)) {
        byId.set(entry.credentialId, entry.errorMessage ?? 'The target address is not allowed.');
      }
    }
    return [...byId].map(([credentialId, reason]) => ({ credentialId, reason }));
  }

  /**
   * Tells a team that one of their provider connections cannot be called at
   * all, because its base URL resolves to an address the gateway refuses.
   *
   * This exists for the case where the call **succeeded**. A blocked primary
   * with a working fallback answers a normal 200, so every request quietly
   * goes to the fallback at the fallback's prices and nothing in the product
   * says otherwise. The span carries a `model_fallback` warning, but that is
   * indistinguishable from an upstream having a bad minute, and nobody reads a
   * trace of a call that worked.
   *
   * Refusing the request instead would trade availability for visibility,
   * which is not this layer's decision to make — so the call still succeeds
   * and the team is told once (see the dedupe key).
   *
   * **Never throws.** Same contract as `notifyBudgetCrossings`: a notification
   * failure must not fail the completion that triggered it.
   *
   * @param teamId - Team that owns the connection.
   * @param blocked - Refused connections, from {@link blockedConnectionsIn}.
   * @param servedByFallback - Whether the request was answered anyway. Changes
   *   what the email leads with, because the two cases need different things
   *   from the reader.
   */
  private async notifyBlockedConnections(
    teamId: string,
    blocked: { credentialId: string; reason: string }[],
    servedByFallback: boolean,
  ): Promise<void> {
    for (const { credentialId, reason } of blocked) {
      try {
        const connection = await this.connectionsRepo.findByIdForTeam(credentialId, teamId);
        if (!connection) continue;
        const teamName = await this.budgetsRepo.findTeamName(teamId);

        await notify({
          teamId,
          // A base URL is connection configuration, which editors and viewers
          // cannot change — the same audience as a budget alert, for the same
          // reason.
          category: 'connection_health',
          audience: { roles: ['owner', 'admin'] },
          // One line per connection per UTC day. A team running a thousand
          // calls an hour against a dead primary gets one email, and a
          // connection still broken tomorrow says so again rather than going
          // quiet after the first notice. The guarantee is BullMQ's: the key
          // holds while the completed job is still in the queue's history,
          // which `removeOnComplete: 1000` caps at the last thousand emails —
          // so an install sending more than that in a day could repeat the
          // notice. Same mechanism, and same limit, as the budget alerts.
          dedupeKey: `connection-blocked:${credentialId}:${new Date().toISOString().slice(0, 10)}`,
          payload: {
            type: 'connection_blocked',
            props: {
              teamName: teamName ?? 'your team',
              connectionName: connection.label,
              provider: connection.provider,
              reason,
              servedByFallback,
              connectionsUrl: appLink('/gateway/connections'),
            },
          },
        });
      } catch (err) {
        // Log and move on. The completion itself is already recorded correctly;
        // a missing alert is much the smaller failure.
        console.error('[connection health] failed to enqueue', { credentialId }, err);
      }
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

    // A caller who rendered the prompt itself sends the version id instead.
    promptVersionId = await this.resolveClientPromptVersionId(ctx, req, promptVersionId);

    // #412: record the values behind the messages whoever rendered them, so a
    // client-rendered run is as replayable as a server-rendered one.
    promptVariables = this.replayVariables(req, promptVariables);

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
    const { gateway, prompt: _prompt, variables: _variables, tool_refs: _toolRefs, prompt_version_id: _pvid, ...rest } = req;
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
    const scopedDeployments = this.scopeDeploymentsToKey(ctx, deployments);

    // 4b. Budget reserve — durable spend caps in Postgres (G4/G5 fix). Lazy-reset
    // each applicable budget, then atomically reserve a conservative cost estimate
    // (priced at the primary deployment's rates) against every one, rejecting (402)
    // if any can't fit. Reserving here — after resolving deployments/pricing but
    // before the paid call — closes the concurrent-request race the old read-then-
    // increment-later check-then-act had. Reconciled to the real cost at step 9.
    const estimatedCostUsd = estimateRequestCostUsd(normalized, scopedDeployments[0].model);
    const { reserved: reservedBudgets, crossed: reservationCrossings } =
      await this.reserveBudgets(ctx, estimatedCostUsd);

    // Bind adapter + decrypted credentials + upstream-model rewrite per deployment.
    const invoke = this.buildInvoker();

    // 7. Call with retry/fallback; measure latency.
    const startedAt = Date.now();
    let served;
    try {
      served = await callWithFallback(scopedDeployments, normalized, invoke, {
        maxRetriesPerConn: gateway?.maxRetries ?? DEFAULT_MAX_RETRIES,
        allowFallback: gateway?.fallback ?? true,
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
        const errorRow = await this.gatewayRepo.recordRequest({
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
        // The row above only reaches the usage page. Without this the trace view showed
        // nothing at all for a failed round, so an agent loop's trace simply stopped mid-run
        // with every span green (issue #452).
        await recordGatewayErrorSpan({ ctx, request: req, gatewayRequestId: errorRow.id });
        // The caller does get `PROVIDER_ADDRESS_BLOCKED` here, but an unattended
        // agent loop reads a 502 and retries. Same notice, same dedupe key.
        const blockedOnFailure = this.blockedConnectionsIn(err.meta.trail);
        if (blockedOnFailure.length > 0)
          await this.notifyBlockedConnections(ctx.teamId, blockedOnFailure, false);
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
    const crossed: BudgetCrossingRecord[] = [];
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

    // The reservation's crossings are sent with the reconciliation's: the
    // reservation already committed its own transaction, and this point is after
    // the recording transaction committed too, so neither can be rolled back now.
    const allCrossings = [...reservationCrossings, ...crossed];
    if (allCrossings.length > 0)
      await this.notifyBudgetCrossings(allCrossings, ctx.teamId, ctx.contributingSource);

    // A deployment in this chain was refused for its address, yet the call
    // still returned 200 — so this is the only thing that will ever say so.
    const blockedOnSuccess = this.blockedConnectionsIn(served.meta.trail);
    if (blockedOnSuccess.length > 0)
      await this.notifyBlockedConnections(ctx.teamId, blockedOnSuccess, true);

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

    // A caller who rendered the prompt itself sends the version id instead (mirror
    // of the non-streaming path).
    promptVersionId = await this.resolveClientPromptVersionId(ctx, req, promptVersionId);

    // #412: mirror of complete() — see `replayVariables`.
    promptVariables = this.replayVariables(req, promptVariables);

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

    // Strip the gateway control field so the body stays OpenAI-compatible. Its
    // `fallback` knob is kept (`maxRetries` is not: a stream commits to a
    // deployment the moment its first chunk arrives, so there is nothing to
    // retry on the same one).
    const { gateway, prompt: _prompt, variables: _variables, tool_refs: _toolRefs, prompt_version_id: _pvid, ...rest } = req;
    const allowFallback = gateway?.fallback ?? true;
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
    const scopedDeployments = this.scopeDeploymentsToKey(ctx, deployments);

    // 4b. Budget reserve (G4/G5 fix, mirrors complete() — see its comment).
    // Reserving before the deployment-fallback loop below means a budget that
    // can't fit the reservation throws here, before any provider stream opens.
    const estimatedCostUsd = estimateRequestCostUsd(normalized, scopedDeployments[0].model);
    const { reserved: reservedBudgets, crossed: reservationCrossings } =
      await this.reserveBudgets(ctx, estimatedCostUsd);

    // 7 (selection). Try deployments in order until one yields a first chunk.
    // Fallback ends the moment a byte is committed — after the first chunk the
    // stream is bound to the selected deployment. The request model is rewritten
    // to the deployment's upstream name for each attempt.
    const abortController = new AbortController();
    let selected: ResolvedDeployment | null = null;
    let iterator: AsyncIterator<StreamChunk> | null = null;
    let firstChunk: IteratorResult<StreamChunk> | null = null;
    // The last provider failure of the selection loop. Kept because the `!selected`
    // branch below used to discard every one of them and answer a fixed 502, so a
    // streaming caller learnt less about a rate limit or a bad key than a
    // non-streaming one did — same request, same upstream, strictly worse answer.
    let lastProviderError: ProviderError | null = null;
    // Kept apart from `lastProviderError`, which every later deployment
    // overwrites — the same reason `callWithFallback` keeps its own copy. A
    // refused target address is a fault in the team's own connection, and it
    // must not be buried by whatever the last deployment in the chain said.
    let streamBlockedError: ProviderError | null = null;
    // Connections this chain was refused for, in order. Read after the loop
    // whether or not anything answered.
    const streamBlocked: { credentialId: string; reason: string }[] = [];

    for (const deployment of scopedDeployments) {
      try {
        const creds: ProviderCredentials = {
          apiKey: decryptStoredSecret(
            deployment.credential.secretCiphertext,
            'provider_credential',
            deployment.credential.label,
          ),
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
        // Nothing sent yet → fall through to the next deployment, unless the
        // caller asked for this model or nothing (`gateway.fallback: false`).
        lastProviderError = err;
        if (err.providerCode === 'SSRF_BLOCKED') {
          if (!streamBlockedError) streamBlockedError = err;
          if (!streamBlocked.some((b) => b.credentialId === deployment.credential.id)) {
            streamBlocked.push({
              credentialId: deployment.credential.id,
              reason: (err.detail ?? err.message).trim(),
            });
          }
        }
        if (!allowFallback) break;
        continue;
      }
    }

    // A refused address is the one failure in the chain the team can fix
    // themselves, so it is the one they are told about — not whatever the last
    // deployment happened to say. Mirrors `callWithFallback`.
    const terminalStreamError = streamBlockedError ?? lastProviderError;

    if (streamBlocked.length > 0)
      await this.notifyBlockedConnections(ctx.teamId, streamBlocked, Boolean(selected));

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
        errorCode: terminalStreamError
          ? (terminalStreamError.providerCode ?? String(terminalStreamError.status))
          : 'PROVIDER_ERROR',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        latencyMs: Date.now() - startedAt,
        meta: {},
        reservedBudgets,
        reservationCrossings,
        estimatedCostUsd,
        promptVersionId,
      });
      // Same reason as the blocking path: a stream that never produced a first chunk used
      // to leave the trace with no llm span at all (issue #452). `requestId` is the
      // pre-minted id the row above was written under.
      await recordGatewayErrorSpan({ ctx, request: req, gatewayRequestId: requestId });
      throw terminalStreamError
        ? this.mapProviderError(terminalStreamError)
        : new BadGatewayError('All providers failed before streaming started.');
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
    // Guards re-entry while the first finalize is still awaiting, so a retry is
    // possible after a failure without two finalizes overlapping.
    let inFlight = false;
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
      // Two flags, because they answer different questions. `finalized` means the
      // ledger row is committed, and is claimed only once the awaited work below has
      // actually succeeded — setting it up front meant a failed `recordStreamRow` (a
      // budget deleted mid-stream, a transaction timeout, a pool blip) left it set,
      // so the reservation could never be credited back and the team's spend stayed
      // inflated by an estimate for a call that was never recorded. `inFlight` means
      // the work is running right now, and stops a second entry from starting while
      // the first is still awaiting: the controller calls this once per stream today,
      // but both a normal end and a client abort route here, and the two can race.
      if (inFlight) return;
      inFlight = true;

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
        reservationCrossings,
        estimatedCostUsd,
        promptVersionId,
      }).catch(async (err: unknown) => {
        // The provider has already been paid for this call, so a failure to record
        // it must not also strand the reservation: credit the estimate back before
        // rethrowing, exactly as the pre-stream error path does. Best-effort — if
        // the database is the thing that is failing, this will fail too, and the
        // original error is the one worth surfacing.
        //
        // This is only correct because `recordStreamRow` cannot reject once its
        // transaction has committed — the alerting that follows the commit swallows
        // its own failures. A rejection raised after the commit would credit the
        // estimate back a second time on top of the reconciliation that already ran,
        // pushing the team's recorded spend below the truth for the rest of the
        // period. Anything added after that commit must keep that guarantee.
        inFlight = false;
        if (reservedBudgets.length > 0) {
          await runInTransaction((tx) =>
            this.reconcileBudgets(tx, reservedBudgets, estimatedCostUsd, 0),
          ).catch(() => undefined);
        }
        throw err;
      });

      // Only now is this stream settled: the ledger row is committed and the
      // reservation reconciled, so a later call is a genuine duplicate.
      finalized = true;

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
    /**
     * Alerts the reservation itself crossed, carried through so the streaming path
     * sends them together with the reconciliation's, in one place.
     */
    reservationCrossings: BudgetCrossingRecord[];
    estimatedCostUsd: number;
    promptVersionId: string | null;
  }): Promise<void> {
    const realCostUsd = p.status === 'error' ? 0 : p.costUsd ?? 0;
    // A failed call alerts about nothing. Its reservation did raise spend and may well
    // have crossed a line on the way up, but the reconciliation below credits every
    // cent of it back in the same transaction — so emailing "you have passed 80%" for
    // a request that returned a 502 and cost nothing is both wrong and expensive: the
    // dedupe key is per (budget, period, crossing), so that one false alert consumes
    // the period's only real one. `complete()` reaches the same outcome by a different
    // route — its failure path credits back and rethrows before any alert is built.
    const crossed: BudgetCrossingRecord[] =
      p.status === 'error' ? [] : [...p.reservationCrossings];
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
    if (crossed.length > 0) await this.notifyBudgetCrossings(crossed, p.ctx.teamId, p.ctx.contributingSource);
  }

  /**
   * Map a terminal provider error (from `callWithFallback`) to the caller-facing HTTP error.
   *
   * A 4xx forwards the provider's own message. That message is the only thing that says
   * *which* rule was broken — OpenAI's strict-mode 400 names the exact property missing
   * from `required` — and a 4xx is the provider describing the caller's own malformed
   * request, so there is nothing to leak in returning it. Flattening it left the caller
   * one opaque sentence and no way to tell two different mistakes apart (issue #356).
   *
   * A 5xx stays flattened: the provider is describing its own internals there, which are
   * neither the caller's business nor useful to them. So do 401 and 403 — those are about
   * the *team's stored credential*, not about the request, and a provider 401 body can
   * echo a masked copy of the key it was sent.
   *
   * A 429 is the exception among those: it is neither our fault nor a secret. Flattening
   * it to a 502 left the caller unable to tell "you are out of quota" (fix the billing
   * plan) from "you are sending too fast" (back off), and answering 5xx invited the
   * retry-on-5xx every HTTP client does by default — the worst possible reply to a rate
   * limit. So it forwards the provider's own reason and its `Retry-After`, under a code
   * distinct from our own limiter's `RATE_LIMITED`.
   *
   * `SSRF_BLOCKED` is the one case here that never reached a provider at all: the
   * team's own `base_url` resolved to an address the gateway will not call, and the
   * request was refused before the socket opened. Flattening it to `PROVIDER_ERROR`
   * told an operator their provider had a bad day, when what they have is a
   * connection to fix — the same distinction the 400 and 429 branches above exist to
   * preserve. The status stays 502, since the refusal is ours and the caller's own
   * request was well formed; only the code becomes specific.
   *
   * @param err - The last provider error carried by `FallbackExhaustedError`.
   * @returns 400 PROVIDER_BAD_REQUEST for a provider 400 (caller's fault); 429
   *   PROVIDER_RATE_LIMITED for a provider 429; 504 PROVIDER_TIMEOUT for a 504/408;
   *   502 PROVIDER_ADDRESS_BLOCKED when the target address was refused; else 502
   *   PROVIDER_ERROR.
   */
  private mapProviderError(err: ProviderError): AppError {
    if (err.providerCode === 'SSRF_BLOCKED') {
      return new AppError(
        `${err.message}. Check this connection's base URL — it must be a public address.`,
        502,
        'PROVIDER_ADDRESS_BLOCKED',
      );
    }
    if (err.status === 400) {
      return new AppError(
        `Provider rejected the request (400): ${err.detail ?? err.message}`,
        400,
        'PROVIDER_BAD_REQUEST',
      );
    }
    if (err.status === 504 || err.status === 408) {
      return new GatewayTimeoutError();
    }
    if (err.status === 429) {
      return new ProviderRateLimitedError(
        `Provider rate limit (429): ${err.detail ?? err.message}`,
        err.retryAfter,
      );
    }
    if (REQUEST_FAULT_STATUSES.has(err.status) && err.detail) {
      // Unknown model, oversized body, unprocessable schema: the same shape of problem as
      // the 400 above, and the provider has already said which one it is.
      return new AppError(
        `Provider rejected the request (${err.status}): ${err.detail}`,
        err.status,
        'PROVIDER_BAD_REQUEST',
      );
    }
    return new BadGatewayError(`Provider error (${err.status}): ${err.message}`);
  }
}
