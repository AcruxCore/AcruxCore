import type { ProviderConnection, GatewayModel } from '@prisma/client';
import { ModelsRepository } from '../models/models.repository';
import { ProviderError, gatewayChainDeadlineMs } from '../providers/adapter';
import { withoutRefusedReasoningEffort } from '../providers/refused-params';
import type { NormalizedRequest, NormalizedResponse } from '../providers/types';
import { raceDeadline } from './deadline';

// ── Deployment resolution ─────────────────────────────────────────────────────

/** A resolved deployment: a registered model plus the credential used to call it. */
export interface ResolvedDeployment {
  model: GatewayModel;
  credential: ProviderConnection;
}

/**
 * Resolves the ordered deployment chain for a public model name: the primary
 * model followed by its direct fallbacks in position order. Resolution is **one
 * level** — a fallback's own fallbacks are not expanded — so the chain cannot
 * cycle. Duplicate model ids are dropped.
 *
 * @param teamId - The team whose registry to look up.
 * @param publicName - The `model` string from the request.
 * @returns Ordered deployments; empty when the public name is not registered
 *   (caller maps empty → 400 MODEL_NOT_REGISTERED).
 */
export async function resolveDeployments(
  teamId: string,
  publicName: string,
): Promise<ResolvedDeployment[]> {
  const repo = new ModelsRepository();
  const primary = await repo.findByPublicName(teamId, publicName);
  if (!primary) return [];

  const chain: ResolvedDeployment[] = [{ model: primary, credential: primary.credential }];
  const seen = new Set<string>([primary.id]);
  for (const fb of primary.fallbacks) {
    if (seen.has(fb.fallbackModel.id)) continue;
    seen.add(fb.fallbackModel.id);
    chain.push({ model: fb.fallbackModel, credential: fb.fallbackModel.credential });
  }
  return chain;
}

// ── Retry/backoff tuning (process-local; single instance in v1) ───────────────

const DEFAULT_MAX_RETRIES_PER_CONN = 1;
const DEFAULT_TIMEOUT_BUDGET_MS = 30_000;

// Short exponential backoff with jitter, per same-deployment retry attempt.
// 200ms, 400ms, 800ms … each capped at 2s so we stay within the timeout budget.
function backoffMs(tryN: number): number {
  const base = 200 * 2 ** tryN;
  const jitter = Math.random() * base * 0.5;
  return Math.min(base + jitter, 2_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Performs the actual provider call for one deployment. Injected by the pipeline
 * (which binds the adapter + decrypted credentials and rewrites the request model
 * to the deployment's upstream name) so the router stays provider-agnostic.
 */
export type DeploymentInvoker = (
  deployment: ResolvedDeployment,
  req: NormalizedRequest,
  /** Aborts with a `TimeoutError` when the chain's overall deadline passes. */
  deadline?: AbortSignal,
) => Promise<NormalizedResponse>;

/** One entry in the fallback trail: the deployment tried and its error (if any). */
export interface FallbackTrailEntry {
  modelId: string;
  /**
   * The registered public name of the model tried, e.g. `unstable-4o-mini`. Carried
   * beside `modelId` because the trail's only readers are humans — a trace panel and a
   * support question — and a bare uuid cannot answer "which model actually served this".
   */
  model: string;
  /** The upstream name that model's provider knows, e.g. `gpt-4o-mini`. */
  upstreamModel: string;
  credentialId: string;
  /**
   * How many times *this* deployment was called before its turn ended. The `attempts`
   * on {@link FallbackMeta} is the total across the whole chain, which cannot say which
   * model was retried once a chain is longer than one entry — so the per-entry count is
   * what separates "retried, then fell back" from "fell back without retrying".
   */
  attempts: number;
  error?: string;
  /**
   * What the provider itself said, when it said anything — the body message an adapter
   * records as `ProviderError.detail`, otherwise the thrown message. The status code in
   * `error` says a call failed; this says why, which is the difference between "401" and
   * "Incorrect API key provided". Truncated, because a provider body can be long and this
   * is stored on every failed attempt of every call.
   */
  errorMessage?: string;
  /**
   * The last failure this deployment hit before it finally answered — set only when
   * `attempts` is above one and the entry itself has no `error`. A retried call that
   * succeeds records how many times it was called and, without this, never records what
   * was going wrong during those calls, which is the one thing worth knowing about it.
   */
  retriedAfter?: { error: string; errorMessage: string };
  /**
   * Set when this deployment's turn ended because its connection's base URL
   * resolved to an address the gateway refuses to call. Its own flag rather
   * than something to be read back out of `errorMessage`, because it is the
   * one entry in a trail that describes a fault in the team's own
   * configuration rather than an upstream having a bad day — and something has
   * to say so, since a working fallback turns the whole call into a normal
   * 200. `GatewayService` scans for it and notifies once per connection.
   */
  blockedAddress?: true;
  /**
   * Request fields this deployment refused with a 400, so the gateway retried it once
   * without them. Set only on the entry that then answered.
   */
  droppedParams?: string[];
}

/** How much of a provider's own error message the trail keeps. */
const MAX_TRAIL_ERROR_CHARS = 300;

/**
 * The provider's own explanation of a failure, trimmed to fit on a span.
 *
 * @param err - The error that ended one attempt.
 * @returns The body detail when the adapter captured one, else the thrown message.
 */
function providerMessage(err: ProviderError): string {
  const raw = (err.detail ?? err.message).trim();
  return raw.length > MAX_TRAIL_ERROR_CHARS ? `${raw.slice(0, MAX_TRAIL_ERROR_CHARS)}\u2026` : raw;
}

/** Telemetry recorded on the gateway_requests row. */
export interface FallbackMeta {
  attempts: number;
  trail: FallbackTrailEntry[];
}

/** Successful fallback outcome: the response, the deployment that served it, meta. */
export interface FallbackResult {
  response: NormalizedResponse;
  deployment: ResolvedDeployment;
  meta: FallbackMeta;
  /** Fields the serving deployment refused, and was retried without. Empty when none. */
  droppedParams: string[];
}

/** Options controlling retry depth, cross-model fallback, and the overall timeout budget. */
export interface FallbackOptions {
  maxRetriesPerConn?: number;
  /**
   * Whether a failed deployment may hand off to the next model in the chain
   * (default `true`). `false` confines the call to the first deployment, so the
   * caller gets the primary model's own error instead of a different model's
   * answer. Same-deployment retries are unaffected — this governs which *model*
   * runs, not how many times one is tried.
   */
  allowFallback?: boolean;
  timeoutBudgetMs?: number;
  /**
   * Ceiling on the whole chain, every retry and fallback included (default
   * `gatewayChainDeadlineMs()`, 90 s). The attempt running when it passes is aborted
   * as a timeout, and no new attempt starts after it.
   */
  chainDeadlineMs?: number;
}

/**
 * Thrown when every deployment in the chain has failed (or a provider rejected
 * the request with a 400). Carries the last provider error, accumulated meta, and
 * the last deployment tried so the pipeline can still log an error row and map the
 * error to the right HTTP status.
 */
export class FallbackExhaustedError extends Error {
  constructor(
    public readonly lastError: ProviderError,
    public readonly meta: FallbackMeta,
    public readonly lastDeployment: ResolvedDeployment | null,
    /**
     * True when calling the whole chain again could succeed: some attempt failed for a
     * passing reason (429, 5xx, network, timeout), or the deadline stopped the chain
     * before every deployment was tried. False when every attempt failed permanently.
     */
    public readonly retriable = false,
  ) {
    super(lastError.message);
    this.name = 'FallbackExhaustedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Calls the ordered deployment chain with same-deployment retries and
 * cross-deployment fallback.
 *
 * Per deployment, retries up to `maxRetriesPerConn` (default 1) on a *retriable*
 * `ProviderError` (429/5xx/network) with exponential backoff+jitter, bounded by
 * `timeoutBudgetMs`. A provider **400** is the caller's fault and is surfaced
 * immediately with no fan-out. The one exception is a 400 that refuses
 * `reasoning_effort`: that deployment is called once more without the field
 * (`withoutRefusedReasoningEffort`), and the result's `droppedParams` says so. A **401/403** (bad key) is not retried on the same
 * deployment but does fall back to the next one. When the chain is exhausted the
 * last error is thrown.
 *
 * The whole chain shares one deadline, `opts.chainDeadlineMs`. Each attempt gets
 * what is left of it as an abort signal, and once it has passed no retry or
 * fallback starts: the caller is answered with the last error instead. Without it
 * a chain of slow deployments outlived the proxies in front of the API, and the
 * caller got their HTML error page instead of ours (issue #732).
 *
 * `opts.allowFallback: false` stops the chain after the first deployment, which is
 * how a caller says "this model or nothing" for a call that must not be silently
 * answered by a different model. Retries still run, because retrying is the same
 * model.
 *
 * @param deployments - Ordered chain from `resolveDeployments`; must be non-empty.
 * @param req - The normalized request (already stripped of the `gateway` control field).
 * @param invoke - Bound provider call for a deployment (adapter + credentials + upstream model).
 * @param opts - Retry depth, timeout budget and chain deadline overrides.
 * @returns The successful response, the serving deployment, and the attempt trail.
 * @throws {FallbackExhaustedError} On a provider 400 (immediate) or when the whole
 *   chain fails; carries `lastError`, `meta`, `lastDeployment`, and `retriable`.
 */
export async function callWithFallback(
  deployments: ResolvedDeployment[],
  req: NormalizedRequest,
  invoke: DeploymentInvoker,
  opts: FallbackOptions = {},
): Promise<FallbackResult> {
  const maxRetries = opts.maxRetriesPerConn ?? DEFAULT_MAX_RETRIES_PER_CONN;
  const allowFallback = opts.allowFallback ?? true;
  const budgetMs = opts.timeoutBudgetMs ?? DEFAULT_TIMEOUT_BUDGET_MS;
  const chainDeadlineMs = opts.chainDeadlineMs ?? gatewayChainDeadlineMs();
  const startedAt = Date.now();
  const pastDeadline = (): boolean => Date.now() - startedAt >= chainDeadlineMs;

  const trail: FallbackTrailEntry[] = [];
  let attempts = 0;
  let lastError: ProviderError | undefined;
  let lastDeployment: ResolvedDeployment | undefined;
  // Kept apart from `lastError`, which every later attempt overwrites. A refused
  // target address is a fault in the team's own connection rather than an
  // upstream having a bad day, and once the whole chain has failed it is the one
  // error the team can act on — so it must not be buried by whatever the last
  // deployment in the chain happened to say.
  let blockedAddressError: ProviderError | undefined;
  // Whether a later call of the same chain could succeed. The answer's status is
  // read from this, not from whichever error is reported, so a backup's permanent
  // failure cannot turn a primary's passing outage into a "do not retry".
  let retriable = false;

  for (const deployment of deployments) {
    // Out of time: answer with what the chain has seen rather than start a model
    // that could not finish before the proxies give up. The models left untried
    // might have answered, so the failure is not a permanent one.
    if (attempts > 0 && pastDeadline()) {
      retriable = true;
      break;
    }
    lastDeployment = deployment;
    const entry = {
      modelId: deployment.model.id,
      model: deployment.model.publicName,
      upstreamModel: deployment.model.upstreamModel,
      credentialId: deployment.credential.id,
    };
    let connError: ProviderError | undefined;
    let tries = 0;
    // Reset per deployment: a field one model refuses may be one the next model takes.
    let deploymentReq = req;
    const droppedParams: string[] = [];

    for (let tryN = 0; tryN <= maxRetries; tryN++) {
      if (tries > 0 && pastDeadline()) break;
      attempts++;
      tries++;
      try {
        const remainingMs = Math.max(chainDeadlineMs - (Date.now() - startedAt), 0);
        const deadline = AbortSignal.timeout(remainingMs);
        const response = await raceDeadline(invoke(deployment, deploymentReq, deadline), deadline);
        trail.push({
          ...entry,
          attempts: tries,
          ...(droppedParams.length > 0 ? { droppedParams: [...droppedParams] } : {}),
          ...(connError
            ? {
                retriedAfter: {
                  error: String(connError.status),
                  errorMessage: providerMessage(connError),
                },
              }
            : {}),
        });
        return { response, deployment, meta: { attempts, trail }, droppedParams };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err; // real bug — never swallow
        lastError = err;
        connError = err;
        if (err.retriable) retriable = true;
        if (!blockedAddressError && err.providerCode === 'SSRF_BLOCKED') blockedAddressError = err;

        // A model that does not take `reasoning_effort` refused it: retry it once
        // without the field. This does not use up one of the retries for a transient error.
        const retryReq = droppedParams.length === 0 ? withoutRefusedReasoningEffort(deploymentReq, err) : null;
        if (retryReq) {
          deploymentReq = retryReq;
          droppedParams.push('reasoning_effort');
          tryN--;
          continue;
        }

        // Caller's fault (malformed request): surface immediately, no fan-out.
        if (err.status === 400) {
          trail.push({
            ...entry,
            attempts: tries,
            error: String(err.status),
            errorMessage: providerMessage(err),
          });
          throw new FallbackExhaustedError(err, { attempts, trail }, deployment);
        }

        // Transient (429/5xx/network): retry the SAME deployment if budget allows.
        const withinBudget = Date.now() - startedAt < budgetMs;
        if (err.retriable && tryN < maxRetries && withinBudget && !pastDeadline()) {
          await sleep(backoffMs(tryN));
          continue;
        }

        // Bad key (401/403) or retries exhausted: stop this deployment, fall back.
        break;
      }
    }

    trail.push({
      ...entry,
      attempts: tries,
      error: connError ? String(connError.status) : 'unknown',
      ...(connError ? { errorMessage: providerMessage(connError) } : {}),
      ...(connError?.providerCode === 'SSRF_BLOCKED' ? { blockedAddress: true as const } : {}),
    });

    // "This model or nothing": the caller opted out of being answered by a
    // different model, so the primary's own error is the answer.
    if (!allowFallback) break;
  }

  // deployments is guaranteed non-empty by the caller (MODEL_NOT_REGISTERED handled
  // upstream), so lastError is always set here.
  throw new FallbackExhaustedError(
    blockedAddressError ?? lastError!,
    { attempts, trail },
    lastDeployment ?? null,
    retriable,
  );
}
