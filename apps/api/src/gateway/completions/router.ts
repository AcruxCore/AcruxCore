import type { ProviderConnection, GatewayModel } from '@prisma/client';
import { ModelsRepository } from '../models/models.repository';
import { ProviderError } from '../providers/adapter';
import type { NormalizedRequest, NormalizedResponse } from '../providers/types';

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
) => Promise<NormalizedResponse>;

/** One entry in the fallback trail: the deployment tried and its error (if any). */
export interface FallbackTrailEntry {
  modelId: string;
  credentialId: string;
  error?: string;
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
}

/** Options controlling retry depth and the overall timeout budget. */
export interface FallbackOptions {
  maxRetriesPerConn?: number;
  timeoutBudgetMs?: number;
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
 * immediately with no fan-out. A **401/403** (bad key) is not retried on the same
 * deployment but does fall back to the next one. When the chain is exhausted the
 * last error is thrown.
 *
 * @param deployments - Ordered chain from `resolveDeployments`; must be non-empty.
 * @param req - The normalized request (already stripped of the `gateway` control field).
 * @param invoke - Bound provider call for a deployment (adapter + credentials + upstream model).
 * @param opts - Retry depth + timeout budget overrides.
 * @returns The successful response, the serving deployment, and the attempt trail.
 * @throws {FallbackExhaustedError} On a provider 400 (immediate) or when the whole
 *   chain fails; carries `lastError`, `meta`, and `lastDeployment`.
 */
export async function callWithFallback(
  deployments: ResolvedDeployment[],
  req: NormalizedRequest,
  invoke: DeploymentInvoker,
  opts: FallbackOptions = {},
): Promise<FallbackResult> {
  const maxRetries = opts.maxRetriesPerConn ?? DEFAULT_MAX_RETRIES_PER_CONN;
  const budgetMs = opts.timeoutBudgetMs ?? DEFAULT_TIMEOUT_BUDGET_MS;
  const startedAt = Date.now();

  const trail: FallbackTrailEntry[] = [];
  let attempts = 0;
  let lastError: ProviderError | undefined;
  let lastDeployment: ResolvedDeployment | undefined;

  for (const deployment of deployments) {
    lastDeployment = deployment;
    const entry = { modelId: deployment.model.id, credentialId: deployment.credential.id };
    let connError: ProviderError | undefined;

    for (let tryN = 0; tryN <= maxRetries; tryN++) {
      attempts++;
      try {
        const response = await invoke(deployment, req);
        trail.push({ ...entry });
        return { response, deployment, meta: { attempts, trail } };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err; // real bug — never swallow
        lastError = err;
        connError = err;

        // Caller's fault (malformed request): surface immediately, no fan-out.
        if (err.status === 400) {
          trail.push({ ...entry, error: String(err.status) });
          throw new FallbackExhaustedError(err, { attempts, trail }, deployment);
        }

        // Transient (429/5xx/network): retry the SAME deployment if budget allows.
        const withinBudget = Date.now() - startedAt < budgetMs;
        if (err.retriable && tryN < maxRetries && withinBudget) {
          await sleep(backoffMs(tryN));
          continue;
        }

        // Bad key (401/403) or retries exhausted: stop this deployment, fall back.
        break;
      }
    }

    trail.push({ ...entry, error: connError ? String(connError.status) : 'unknown' });
  }

  // deployments is guaranteed non-empty by the caller (MODEL_NOT_REGISTERED handled
  // upstream), so lastError is always set here.
  throw new FallbackExhaustedError(lastError!, { attempts, trail }, lastDeployment ?? null);
}
