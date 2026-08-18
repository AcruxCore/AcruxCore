import type { Usage } from './types';

/** One row of the static model → provider + pricing + context-window table. */
export interface ModelInfo {
  model: string;
  provider: 'openai' | 'anthropic' | 'openai_compatible' | 'gemini';
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPricePerM: number;
  /** USD per 1,000,000 output (completion) tokens. */
  outputPricePerM: number;
  contextWindow: number;
}

/**
 * Static, versioned pricing registry (FAQ Q8). Prices in USD per 1M tokens.
 * Adding/updating a model is a reviewed code change, never a runtime edit.
 */
export const MODELS: Record<string, ModelInfo> = {
  'gpt-4o': {
    model: 'gpt-4o',
    provider: 'openai',
    inputPricePerM: 2.5,
    outputPricePerM: 10,
    contextWindow: 128_000,
  },
  'gpt-4o-mini': {
    model: 'gpt-4o-mini',
    provider: 'openai',
    inputPricePerM: 0.15,
    outputPricePerM: 0.6,
    contextWindow: 128_000,
  },
  'claude-3-5-sonnet-latest': {
    model: 'claude-3-5-sonnet-latest',
    provider: 'anthropic',
    inputPricePerM: 3,
    outputPricePerM: 15,
    contextWindow: 200_000,
  },
  'gemini-2.0-flash': {
    model: 'gemini-2.0-flash',
    provider: 'gemini',
    inputPricePerM: 0.1,
    outputPricePerM: 0.4,
    contextWindow: 1_048_576,
  },
  'gemini-1.5-pro': {
    model: 'gemini-1.5-pro',
    provider: 'gemini',
    inputPricePerM: 1.25,
    outputPricePerM: 5,
    contextWindow: 2_097_152,
  },
  'gemini-1.5-flash': {
    model: 'gemini-1.5-flash',
    provider: 'gemini',
    inputPricePerM: 0.075,
    outputPricePerM: 0.3,
    contextWindow: 1_048_576,
  },
};

/**
 * Strips a trailing provider date-snapshot suffix (e.g. `-2024-07-18`) so a
 * dated model id a provider actually served (`gpt-4o-mini-2024-07-18`) still
 * matches the un-dated registry key (`gpt-4o-mini`) a caller requested by
 * alias. Providers commonly echo the dated form back in the response — and
 * OTLP-ingested traces from third-party frameworks report whatever string the
 * provider returned, not the alias AcruxCore's own gateway users configure.
 *
 * @param model - A model id, possibly with a trailing `-YYYY-MM-DD` suffix.
 * @returns `model` with any trailing date suffix removed; unchanged if none.
 */
function stripDateSuffix(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/**
 * Compute the USD cost of a completion from provider-reported usage.
 *
 * @param model - The requested model name (registry key), or a provider-dated
 *          variant of one (e.g. `gpt-4o-mini-2024-07-18`).
 * @param usage - Token counts reported by the provider.
 * @returns Cost in USD, or `null` if the model (dated or not) is not in the
 *          registry (the call is still served; the caller logs the null cost).
 */
export function computeCost(model: string, usage: Usage): number | null {
  const m = MODELS[model] ?? MODELS[stripDateSuffix(model)];
  if (!m) return null;
  return (usage.prompt_tokens / 1e6) * m.inputPricePerM + (usage.completion_tokens / 1e6) * m.outputPricePerM;
}

/**
 * Resolve a request model to its provider. Prefers the pricing registry; falls back
 * to a name-prefix heuristic so models absent from the registry (cost logged null)
 * can still be routed (spec: "unknown model → served, cost null").
 *
 * @param model - The requested model name.
 * @returns The provider kind, or `null` if it cannot be inferred (no registry entry
 *          and no recognized name prefix).
 */
export function resolveProvider(
  model: string,
): 'openai' | 'anthropic' | 'openai_compatible' | 'gemini' | null {
  const known = MODELS[model];
  if (known) return known.provider;
  if (/^(gpt-|o1|o3|chatgpt)/i.test(model)) return 'openai';
  if (/^claude/i.test(model)) return 'anthropic';
  if (/^gemini/i.test(model)) return 'gemini';
  return null;
}

/**
 * Look up default per-1M-token pricing for a known upstream model, used to
 * prefill the Add-Model form. Exact key match only — arbitrary/aggregator model
 * ids (e.g. OpenRouter's) return null and the owner sets prices manually.
 *
 * @param upstreamModel - The upstream model id (registry key).
 * @returns `{ inputPricePerM, outputPricePerM }` in USD, or null if not known.
 */
export function lookupDefaultPricing(
  upstreamModel: string,
): { inputPricePerM: number; outputPricePerM: number } | null {
  const m = MODELS[upstreamModel];
  if (!m) return null;
  return { inputPricePerM: m.inputPricePerM, outputPricePerM: m.outputPricePerM };
}

/**
 * Compute the USD cost of a completion from a registered model's stored prices.
 *
 * @param inputPricePerM - USD per 1M prompt tokens, or null when unpriced.
 * @param outputPricePerM - USD per 1M completion tokens, or null when unpriced.
 * @param usage - Token counts reported by the provider.
 * @returns Cost in USD, or `null` when either price is null (cost logged null).
 */
export function computeCostFromPrices(
  inputPricePerM: { toNumber(): number } | number | null,
  outputPricePerM: { toNumber(): number } | number | null,
  usage: Usage,
): number | null {
  if (inputPricePerM == null || outputPricePerM == null) return null;
  const inP = typeof inputPricePerM === 'number' ? inputPricePerM : inputPricePerM.toNumber();
  const outP = typeof outputPricePerM === 'number' ? outputPricePerM : outputPricePerM.toNumber();
  return (usage.prompt_tokens / 1e6) * inP + (usage.completion_tokens / 1e6) * outP;
}
