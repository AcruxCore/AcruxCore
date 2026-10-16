import type { Usage } from './types';

/** One row of the static model → provider + pricing + context-window table. */
export interface ModelInfo {
  model: string;
  provider: 'openai' | 'anthropic' | 'openai_compatible' | 'gemini';
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPricePerM: number;
  /** USD per 1,000,000 output (completion) tokens. */
  outputPricePerM: number;
  /**
   * Fraction of `inputPricePerM` charged for a prompt token the provider served from its
   * own prefix cache. Omit to use its provider's read rate (`cacheRatesFor`); set it only
   * for a model whose published cached rate differs from that default.
   */
  cachedInputDiscount?: number;
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
 * Fraction of the full input rate charged for a cached prompt token, when the model has no
 * `cachedInputDiscount` of its own.
 *
 * OpenAI caches any prompt prefix over ~1024 tokens automatically — no client opt-in — and
 * bills the cached part at half the input rate for every model in `MODELS`. A provider that
 * reports no cached count is unaffected: `cached_tokens` is then absent and nothing is
 * discounted.
 */
export const CACHED_INPUT_DISCOUNT = 0.5;

/** How a provider bills the two kinds of cached prompt token, as fractions of the input rate. */
export interface CacheRates {
  /** Charged per token served from the cache (`usage.cached_tokens`). */
  read: number;
  /** Charged per token written into the cache (`usage.cache_write_tokens`). */
  write: number;
  /**
   * The model's own cached input price, USD per 1M tokens. When set, cached tokens are billed
   * at this price and `read` is not used. Kept as a price rather than turned into a fraction
   * of the input price, so it still applies when the input price is $0.
   */
  readPricePerM?: number;
}

/** A stored price: Prisma returns a `Decimal`, tests and the registry pass a plain number. */
export type StoredPrice = { toNumber(): number } | number;

/**
 * Reads a stored price as a number.
 *
 * @param price - A Prisma `Decimal` or a plain number.
 * @returns The price in USD per 1M tokens.
 */
export function priceToNumber(price: StoredPrice): number {
  return typeof price === 'number' ? price : price.toNumber();
}

/** OpenAI-style automatic caching: reads at half price, nothing is ever billed as a write. */
export const DEFAULT_CACHE_RATES: CacheRates = { read: CACHED_INPUT_DISCOUNT, write: 1 };

/**
 * Anthropic's published cache pricing for the default five-minute cache: a read costs 0.1x the
 * input rate and a write costs 1.25x. Using OpenAI's 0.5x here would bill a cache hit at five
 * times its real price (issue #552).
 */
export const ANTHROPIC_CACHE_RATES: CacheRates = { read: 0.1, write: 1.25 };

/**
 * Google's published cached-input price for Gemini: 0.1x the input rate on every current
 * model that offers caching (ai.google.dev/gemini-api/docs/pricing, checked 16 Oct 2026 —
 * e.g. gemini-2.5-flash $0.03 against $0.30). Gemini bills no separate cache write on the
 * implicit cache. A team whose model differs sets its own cached input price (issue #595).
 */
export const GEMINI_CACHE_RATES: CacheRates = { read: 0.1, write: 1 };

/**
 * Google's cached-input price for the Gemini 1.5 and 2.0 families: 0.25x the input rate
 * (gemini-2.0-flash $0.025 against $0.10). The built-in registry still prices these models,
 * and an SDK span priced from the registry has no team setting to correct the rate.
 */
export const GEMINI_LEGACY_CACHE_RATES: CacheRates = { read: 0.25, write: 1 };

/** Gemini ids from the 1.5 and 2.0 families, e.g. `gemini-2.0-flash` or `google/gemini-1.5-pro-002`. */
const GEMINI_LEGACY_ID = /(^|\/)gemini-(1\.5|2\.0)-/i;

/**
 * Whether an upstream model id names a Gemini model, whatever connection serves it.
 *
 * @param upstreamModel - The id the provider knows, e.g. `google/gemini-2.5-flash`.
 * @returns True for an id whose last path segment starts with `gemini-`.
 */
export function isGeminiModel(upstreamModel: string): boolean {
  return /(^|\/)gemini-/i.test(upstreamModel);
}

/**
 * Whether an upstream model id names an Anthropic model, whatever connection serves it.
 *
 * An `openai_compatible` connection such as OpenRouter reaches Claude as `anthropic/claude-…`,
 * so the connection's provider alone cannot say whether `cache_control` applies.
 *
 * @param upstreamModel - The id the provider knows, e.g. `anthropic/claude-haiku-5.5`.
 * @returns True for any id containing `claude` or starting with `anthropic/`.
 */
export function isAnthropicModel(upstreamModel: string): boolean {
  return /claude/i.test(upstreamModel) || /^anthropic\//i.test(upstreamModel);
}

/**
 * Picks the cache rates a served call is billed at.
 *
 * @param provider - The provider of the connection that served the call.
 * @param upstreamModel - The upstream model id that connection was asked for.
 * @returns `ANTHROPIC_CACHE_RATES` for a native Anthropic connection or an Anthropic model behind
 *          any other connection, `GEMINI_LEGACY_CACHE_RATES` for a Gemini 1.5 or 2.0 id,
 *          `GEMINI_CACHE_RATES` for any other Gemini model, `DEFAULT_CACHE_RATES` otherwise.
 */
export function cacheRatesFor(provider: string, upstreamModel: string): CacheRates {
  if (provider === 'anthropic' || isAnthropicModel(upstreamModel)) return ANTHROPIC_CACHE_RATES;
  if (GEMINI_LEGACY_ID.test(upstreamModel)) return GEMINI_LEGACY_CACHE_RATES;
  if (provider === 'gemini' || isGeminiModel(upstreamModel)) return GEMINI_CACHE_RATES;
  return DEFAULT_CACHE_RATES;
}

/**
 * Picks the cache rates for a team's registered model: its own cached input price when it
 * has one, otherwise its provider's default (`cacheRatesFor`).
 *
 * Providers publish their own cached rate. z.ai's glm-5.3 charges $0.26 against $1.40 input,
 * 0.186x, so the fixed 0.5x default overstated every cache hit by about a third (issue #594).
 *
 * @param provider - The provider of the connection that serves the model.
 * @param upstreamModel - The id the provider knows.
 * @param cachedInputPricePerM - The model's cached input price, or null to use the default.
 * @returns The provider's default fractions, plus `readPricePerM` when the model has a cached
 *          price. Only reads are overridden: no provider that reports a cache write lets a
 *          team enter its own write rate yet.
 */
export function cacheRatesForModel(
  provider: string,
  upstreamModel: string,
  cachedInputPricePerM: StoredPrice | null,
): CacheRates {
  const rates = cacheRatesFor(provider, upstreamModel);
  return cachedInputPricePerM == null ? rates : { ...rates, readPricePerM: priceToNumber(cachedInputPricePerM) };
}

/**
 * Splits prompt tokens into the parts billed at the full, cache-read and cache-write rates, and
 * returns the blended input cost.
 *
 * `usage.cached_tokens` and `usage.cache_write_tokens` are both subsets of `usage.prompt_tokens`,
 * so they are subtracted rather than added. Each is clamped so the parts never exceed
 * `prompt_tokens`, because the figures come from a provider we do not control — a bogus count
 * must not produce a negative cost.
 *
 * @param usage - Provider-reported token counts.
 * @param inputPricePerM - USD per 1M prompt tokens at the full rate.
 * @param rates - Fractions of `inputPricePerM` charged for a cache read and a cache write.
 * @returns USD cost of the prompt side of the call.
 */
function inputCost(usage: Usage, inputPricePerM: number, rates: CacheRates): number {
  const cached = Math.min(Math.max(usage.cached_tokens ?? 0, 0), usage.prompt_tokens);
  const written = Math.min(Math.max(usage.cache_write_tokens ?? 0, 0), usage.prompt_tokens - cached);
  const full = usage.prompt_tokens - cached - written;
  if (rates.readPricePerM !== undefined) {
    return ((full + written * rates.write) / 1e6) * inputPricePerM + (cached / 1e6) * rates.readPricePerM;
  }
  return ((full + cached * rates.read + written * rates.write) / 1e6) * inputPricePerM;
}

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
export function stripDateSuffix(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/**
 * Compute the USD cost of a completion from provider-reported usage.
 *
 * @param model - The requested model name (registry key), or a provider-dated
 *          variant of one (e.g. `gpt-4o-mini-2024-07-18`).
 * @param usage - Token counts reported by the provider. Any `cached_tokens` subset is billed
 *          at the model's `cachedInputDiscount`, defaulting to its provider's cache read rate;
 *          any `cache_write_tokens` subset at its provider's write rate (`cacheRatesFor`).
 * @returns Cost in USD, or `null` if the model (dated or not) is not in the
 *          registry (the call is still served; the caller logs the null cost).
 */
export function computeCost(model: string, usage: Usage): number | null {
  const m = MODELS[model] ?? MODELS[stripDateSuffix(model)];
  if (!m) return null;
  const rates = cacheRatesFor(m.provider, m.model);
  return (
    inputCost(usage, m.inputPricePerM, { ...rates, read: m.cachedInputDiscount ?? rates.read }) +
    (usage.completion_tokens / 1e6) * m.outputPricePerM
  );
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
 * @param usage - Token counts reported by the provider. Its `cached_tokens` and
 *          `cache_write_tokens` subsets are billed at `rates`.
 * @param rates - Cache read/write fractions of `inputPricePerM`. A registered model stores one
 *          input price, so the caller derives these from the served provider and upstream model
 *          with `cacheRatesFor`. Defaults to OpenAI's rates.
 * @returns Cost in USD, or `null` when either price is null (cost logged null).
 */
export function computeCostFromPrices(
  inputPricePerM: StoredPrice | null,
  outputPricePerM: StoredPrice | null,
  usage: Usage,
  rates: CacheRates = DEFAULT_CACHE_RATES,
): number | null {
  if (inputPricePerM == null || outputPricePerM == null) return null;
  return (
    inputCost(usage, priceToNumber(inputPricePerM), rates) +
    (usage.completion_tokens / 1e6) * priceToNumber(outputPricePerM)
  );
}
