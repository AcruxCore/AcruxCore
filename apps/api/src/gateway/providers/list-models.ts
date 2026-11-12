import { guardedFetch } from './guarded-fetch';
import type { ProviderKind } from '../connections/connections.types';
import { ProviderError } from './adapter';
import type { ProviderCredentials } from './types';
import { RUNWARE_BASE_URL } from './openai.adapter';

/** A listed model's prices in USD per 1M tokens, as the provider's own list states them. */
export interface ListedModelPricing {
  inputPricePerM: number;
  outputPricePerM: number;
  /** Present only when the list states a cache-read price. */
  cachedInputPricePerM?: number;
}

/** One model from a provider's own list. */
export interface ListedModel {
  id: string;
  /**
   * Present only when the provider's list states both prices (Runware, OpenRouter). The
   * dashboard copies them into the Add-model form; nothing is stored until the user saves.
   */
  pricing?: ListedModelPricing;
}


const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const ANTHROPIC_VERSION = '2023-06-01';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const RUNWARE_MODELS_URL = `${RUNWARE_BASE_URL}/models`;

/** Decimal places a model price column stores (`Decimal(12, 4)`); listed prices are rounded to it. */
const PRICE_DECIMALS = 4;

/**
 * Whether an OpenAI-compatible base URL is OpenRouter's own host, whose list states prices in
 * USD per token. No other host's unit is known: one could state per-1M prices under the same
 * field names, which would be copied a million times too high, so other hosts list bare ids.
 *
 * @param baseUrl - The connection's base URL.
 * @returns True for `openrouter.ai` and its subdomains.
 */
export function listsPerTokenPrices(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/**
 * A model list is a small, quick read. It gets a much shorter headers deadline than a
 * completion, so a dialog waiting on it fails over to free-text entry in seconds.
 */
const LIST_TIMEOUT_MS = 15_000;

/**
 * OpenAI's own `/models` also lists embedding, speech, image and moderation models,
 * none of which the chat-completions gateway can call. They are dropped for the
 * `openai` kind only; an OpenAI-compatible host such as OpenRouter lists chat models,
 * and its ids follow no naming rule we could filter on safely.
 */
const OPENAI_NON_CHAT = /(embedding|tts|whisper|dall-e|moderation|davinci|babbage|transcribe|audio|realtime|image|search|sora|computer-use)/i;

const LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  openai_compatible: 'OpenAI-compatible provider',
  runware: 'Runware',
};

interface Target {
  url: string;
  headers: Record<string, string>;
  usesCustomBaseUrl: boolean;
  /** Pulls the models out of this provider's response body. */
  extract: (body: unknown) => ListedModel[];
}

/** Reads `data[].id`, the shape OpenAI, Anthropic and OpenAI-compatible hosts share. */
function dataIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Reads one per-token price string as USD per 1M tokens.
 *
 * Runware and OpenRouter state prices per token as decimal strings (`"0.00000025"`). A
 * negative price is OpenRouter's marker for a router whose cost depends on the model it
 * picks, so it counts as no price. The product is rounded to 12 significant digits, so
 * `0.00000025 * 1e6` reads as `0.25`, not `0.24999999999999997`, then to the 4 decimals the
 * price columns store, so the form shows what saving it would store (a price under $0.00005
 * per 1M reads as 0).
 *
 * @param raw - The field's value, of any type.
 * @returns USD per 1M tokens, or `undefined` when the value is missing, not a number, or negative.
 */
function perMillion(raw: unknown): number | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  const exact = Number((perToken * 1_000_000).toPrecision(12));
  return Math.round(exact * 10 ** PRICE_DECIMALS) / 10 ** PRICE_DECIMALS;
}

/**
 * Reads the `pricing` object of an OpenRouter-shaped model entry (`prompt`, `completion`,
 * `input_cache_read`, each USD per token).
 *
 * @param entry - One element of the list's `data[]`.
 * @returns The prices, or `undefined` unless both the input and the output price are usable:
 *   a half-priced model would bill only one side, so it is left for the user to fill in.
 */
function listedPricing(entry: unknown): ListedModelPricing | undefined {
  const pricing = (entry as { pricing?: Record<string, unknown> } | null)?.pricing;
  if (!pricing || typeof pricing !== 'object') return undefined;
  const input = perMillion(pricing['prompt']);
  const output = perMillion(pricing['completion']);
  if (input === undefined || output === undefined) return undefined;
  const cached = perMillion(pricing['input_cache_read']);
  return { inputPricePerM: input, outputPricePerM: output, ...(cached !== undefined ? { cachedInputPricePerM: cached } : {}) };
}

/**
 * Reads `data[]` as models with any prices the list states. Used for hosts whose list can
 * carry OpenRouter-style `pricing` (Runware, OpenRouter); a host without it yields bare ids.
 */
function pricedModels(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ListedModel[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const pricing = listedPricing(entry);
    out.push(pricing ? { id, pricing } : { id });
  }
  return out;
}

/** Wraps bare ids as listed models. */
function toModels(ids: string[]): ListedModel[] {
  return ids.map((id) => ({ id }));
}

/** Reads Gemini's `models[]`, keeping only models that can generate content. */
function geminiIds(body: unknown): string[] {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => {
      const methods = (m as { supportedGenerationMethods?: unknown })?.supportedGenerationMethods;
      return Array.isArray(methods) && methods.includes('generateContent');
    })
    .map((m) => (m as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === 'string')
    // The API names a model `models/gemini-2.0-flash`; the gateway sends the bare id.
    .map((n) => n.replace(/^models\//, ''));
}

/** Builds the request for one provider's list-models endpoint. */
function targetFor(provider: ProviderKind, creds: ProviderCredentials): Target {
  switch (provider) {
    case 'anthropic':
      // Anthropic has one fixed host; a stored base_url is inert, as on the completion path.
      return {
        url: ANTHROPIC_MODELS_URL,
        headers: { 'x-api-key': creds.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        usesCustomBaseUrl: false,
        extract: (body) => toModels(dataIds(body)),
      };
    case 'gemini': {
      const base = (creds.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');
      return {
        url: `${base}/models?pageSize=1000`,
        headers: { 'x-goog-api-key': creds.apiKey },
        usesCustomBaseUrl: creds.baseUrl !== undefined,
        extract: (body) => toModels(geminiIds(body)),
      };
    }
    case 'openai_compatible': {
      if (!creds.baseUrl) {
        throw new ProviderError('openai_compatible connection is missing base_url', 502, 'MISSING_BASE_URL', false);
      }
      return {
        url: `${creds.baseUrl.replace(/\/+$/, '')}/models`,
        headers: { ...(creds.headers ?? {}), Authorization: `Bearer ${creds.apiKey}` },
        usesCustomBaseUrl: true,
        extract: listsPerTokenPrices(creds.baseUrl) ? pricedModels : (body) => toModels(dataIds(body)),
      };
    }
    case 'runware':
      // One fixed host, like Anthropic; a stored base_url is inert. Every model it lists is a
      // chat model (`output_modalities: ["text"]`), so nothing is filtered out.
      return {
        url: RUNWARE_MODELS_URL,
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        usesCustomBaseUrl: false,
        extract: pricedModels,
      };
    case 'openai': {
      const base = (creds.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');
      return {
        url: `${base}/models`,
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        usesCustomBaseUrl: creds.baseUrl !== undefined,
        extract: (body) => toModels(dataIds(body).filter((id) => !OPENAI_NON_CHAT.test(id))),
      };
    }
  }
}

/**
 * Lists the model ids a provider credential can call, read live from the provider.
 *
 * Live rather than from the static pricing table in `models.ts`: that table holds a
 * handful of models for pricing and goes stale, while a provider's own list is always
 * current and already limited to what this key may use. The request goes through
 * {@link guardedFetch}, so a team-supplied base URL gets the same SSRF guard and
 * response-size cap as a completion.
 *
 * @param provider - The connection's provider kind.
 * @param creds - The decrypted key, plus the base URL and extra headers the connection stores.
 * @returns Unique models sorted by id. A model carries `pricing` only when the provider's
 *   own list states it (Runware, OpenRouter); otherwise the user types the prices when
 *   registering it (cross-cutting FAQ Q160). Empty when the provider lists none.
 * @throws {ProviderError} When the provider answers non-2xx (its status and message are
 *   kept), the base URL is missing or blocked, or the body is not JSON.
 * @throws {DOMException} `TimeoutError` when no response headers arrive within 15 s.
 */
export async function listProviderModels(provider: ProviderKind, creds: ProviderCredentials): Promise<ListedModel[]> {
  const label = LABELS[provider];
  const target = targetFor(provider, creds);
  const { res, dispatcher } = await guardedFetch(
    target.url,
    { method: 'GET', headers: { Accept: 'application/json', ...target.headers } },
    target.usesCustomBaseUrl,
    label,
    LIST_TIMEOUT_MS,
    true,
  );
  try {
    const text = await res.text();
    if (!res.ok) {
      throw new ProviderError(
        `${label} refused the model list (HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status,
        'PROVIDER_ERROR',
        false,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError(`${label} returned a model list that is not JSON`, 502, 'BAD_RESPONSE', false);
    }
    // First entry wins on a duplicate id, then sorted for a stable dropdown.
    const unique = new Map<string, ListedModel>();
    for (const m of target.extract(body)) if (!unique.has(m.id)) unique.set(m.id, m);
    return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    await dispatcher?.close();
  }
}
