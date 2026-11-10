import { guardedFetch } from './guarded-fetch';
import { ProviderError } from './adapter';
import type { ProviderCredentials } from './types';

/** One model id from a provider's own list. */
export interface ListedModel {
  id: string;
}

/** The provider kinds a connection can have. */
type ProviderKind = 'openai' | 'anthropic' | 'openai_compatible' | 'gemini';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const ANTHROPIC_VERSION = '2023-06-01';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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
        extract: (body) => toModels(dataIds(body)),
      };
    }
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
 * @returns Unique models sorted by id, with no prices: the user types a model's prices
 *   when registering it (owner decision, FAQ Q160). Empty when the provider lists none.
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
