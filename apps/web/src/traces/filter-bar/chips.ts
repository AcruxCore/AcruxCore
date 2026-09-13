import type { SpanStatus } from '@/api/types';

/** Which part of a trace the free-text `q` searches. Mirrors the API's `q_in`. */
export type QueryScope = 'all' | 'input' | 'output' | 'name';

/** How a feedback row's rating narrows a search. Mirrors the API's `rating`. */
export type RatingFilter = 'up' | 'down' | 'none';

/**
 * Every filter the bar can express, in one shape.
 *
 * Deliberately a superset of both surfaces rather than two types: the trace list
 * and the feedback feed share their whole vocabulary apart from four fields, and
 * two near-identical types would drift the moment a filter is added to one. Each
 * surface decides which chips it *offers*; the state can hold any of them.
 */
export interface FilterState {
  q?: string;
  qIn?: QueryScope;
  promptId?: string;
  promptVersionId?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  model?: string;
  status?: SpanStatus;
  sessionId?: string;
  minScore?: number;
  maxScore?: number;
  minLatencyMs?: number;
  minCostUsd?: number;
  minTokens?: number;
  /** Feedback surfaces only. */
  rating?: RatingFilter;
  /** Feedback surfaces only. */
  source?: string;
  /** Feedback surfaces only. */
  label?: string;
  /** Feedback surfaces only. */
  hasComment?: boolean;
  from?: string;
  to?: string;
}

/** One rendered filter chip. `key` is what {@link removeChip} takes back. */
export interface Chip {
  key: string;
  label: string;
}

const STATUSES = new Set<string>(['ok', 'error', 'unset']);
const SCOPES = new Set<string>(['all', 'input', 'output', 'name']);
const RATINGS = new Set<string>(['up', 'down', 'none']);
const SOURCES = new Set<string>(['user', 'developer', 'end_user', 'api']);

/** Prefixes that name a filter, as opposed to appearing inside ordinary text. */
const KNOWN_PREFIXES = new Set<string>([
  'prompt', 'version', 'tag', 'input', 'output', 'name', 'model', 'status',
  'session', 'rating', 'source', 'label', 'comment',
]);

/** Strips one pair of surrounding quotes, so `label:"needs review"` works. */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Wraps a value in quotes only when it contains a space, for round-tripping. */
function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Parses a positive number, or undefined when the text is not one. */
function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const METADATA_PARAM = /^metadata\[(.+)\]$/;

/**
 * Reads a URL query string into filter state.
 *
 * Unknown params are ignored rather than rejected: a saved view stores its query
 * verbatim, so a param a later release stops recognising must simply stop
 * filtering instead of breaking the page.
 *
 * @param sp - The params to read (from `useSearchParams`, or a saved view's string).
 * @returns The filters those params express. Pagination is not part of a filter.
 */
export function parseFilterState(sp: URLSearchParams): FilterState {
  const state: FilterState = {};

  const q = sp.get('q');
  if (q) state.q = q;
  const qIn = sp.get('q_in');
  if (qIn && SCOPES.has(qIn)) state.qIn = qIn as QueryScope;

  const promptId = sp.get('prompt_id');
  if (promptId) state.promptId = promptId;
  const versionId = sp.get('prompt_version_id');
  if (versionId) state.promptVersionId = versionId;

  const tags = sp.getAll('tags');
  if (tags.length > 0) state.tags = tags;

  const metadata: Record<string, string> = {};
  for (const [k, v] of sp.entries()) {
    const m = METADATA_PARAM.exec(k);
    if (m) metadata[m[1]] = v;
  }
  if (Object.keys(metadata).length > 0) state.metadata = metadata;

  const model = sp.get('model');
  if (model) state.model = model;
  const status = sp.get('status');
  if (status && STATUSES.has(status)) state.status = status as SpanStatus;
  const sessionId = sp.get('session_id');
  if (sessionId) state.sessionId = sessionId;

  const minScore = num(sp.get('min_score'));
  if (minScore !== undefined) state.minScore = minScore;
  const maxScore = num(sp.get('max_score'));
  if (maxScore !== undefined) state.maxScore = maxScore;
  const minLatencyMs = num(sp.get('min_latency_ms'));
  if (minLatencyMs !== undefined) state.minLatencyMs = minLatencyMs;
  const minCostUsd = num(sp.get('min_cost_usd'));
  if (minCostUsd !== undefined) state.minCostUsd = minCostUsd;
  const minTokens = num(sp.get('min_tokens'));
  if (minTokens !== undefined) state.minTokens = minTokens;

  const rating = sp.get('rating');
  if (rating && RATINGS.has(rating)) state.rating = rating as RatingFilter;
  const source = sp.get('source');
  if (source) state.source = source;
  const label = sp.get('label');
  if (label) state.label = label;
  const hasComment = sp.get('has_comment');
  if (hasComment === 'true') state.hasComment = true;
  if (hasComment === 'false') state.hasComment = false;

  const from = sp.get('from');
  if (from) state.from = from;
  const to = sp.get('to');
  if (to) state.to = to;

  return state;
}

/**
 * Writes filter state back to URL params.
 *
 * `base` lets a caller keep params the bar knows nothing about (a tab, a sort)
 * while every filter param is rewritten from `state` — so removing a chip really
 * removes it rather than leaving a stale param behind.
 *
 * @param state - The filters to serialise.
 * @param base - Params to preserve; every filter key in it is cleared first.
 * @returns Params ready for the URL or for a saved view.
 */
export function filterStateToParams(state: FilterState, base?: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(base);
  for (const key of [
    'q', 'q_in', 'prompt_id', 'prompt_version_id', 'tags', 'model', 'status', 'session_id',
    'min_score', 'max_score', 'min_latency_ms', 'min_cost_usd', 'min_tokens',
    'rating', 'source', 'label', 'has_comment', 'from', 'to',
  ]) {
    sp.delete(key);
  }
  for (const key of [...sp.keys()]) {
    if (METADATA_PARAM.test(key)) sp.delete(key);
  }

  if (state.q) sp.set('q', state.q);
  if (state.qIn && state.qIn !== 'all') sp.set('q_in', state.qIn);
  if (state.promptId) sp.set('prompt_id', state.promptId);
  if (state.promptVersionId) sp.set('prompt_version_id', state.promptVersionId);
  for (const tag of state.tags ?? []) sp.append('tags', tag);
  for (const [k, v] of Object.entries(state.metadata ?? {})) sp.set(`metadata[${k}]`, v);
  if (state.model) sp.set('model', state.model);
  if (state.status) sp.set('status', state.status);
  if (state.sessionId) sp.set('session_id', state.sessionId);
  if (state.minScore !== undefined) sp.set('min_score', String(state.minScore));
  if (state.maxScore !== undefined) sp.set('max_score', String(state.maxScore));
  if (state.minLatencyMs !== undefined) sp.set('min_latency_ms', String(state.minLatencyMs));
  if (state.minCostUsd !== undefined) sp.set('min_cost_usd', String(state.minCostUsd));
  if (state.minTokens !== undefined) sp.set('min_tokens', String(state.minTokens));
  if (state.rating) sp.set('rating', state.rating);
  if (state.source) sp.set('source', state.source);
  if (state.label) sp.set('label', state.label);
  if (state.hasComment !== undefined) sp.set('has_comment', String(state.hasComment));
  if (state.from) sp.set('from', state.from);
  if (state.to) sp.set('to', state.to);

  return sp;
}

/** Readable names for ids the state stores as UUIDs. */
export interface ChipLabels {
  /** promptId → prompt name, so a chip never shows a bare UUID. */
  prompts?: Record<string, string>;
}

/**
 * Renders filter state as removable chips, in a stable order.
 *
 * The order is fixed rather than insertion-ordered so a chip does not move when
 * an unrelated one is removed — a row of chips that reshuffles is hard to aim at.
 *
 * @param state - The current filters.
 * @param labels - Optional readable names for id-valued filters.
 * @returns One chip per active filter.
 */
export function stateToChips(state: FilterState, labels: ChipLabels = {}): Chip[] {
  const chips: Chip[] = [];

  if (state.q) {
    const scope = state.qIn && state.qIn !== 'all' ? state.qIn : null;
    chips.push({ key: 'q', label: scope ? `${scope}:${quoteIfNeeded(state.q)}` : quoteIfNeeded(state.q) });
  }
  if (state.promptId) {
    chips.push({ key: 'promptId', label: `prompt:${labels.prompts?.[state.promptId] ?? state.promptId.slice(0, 8)}` });
  }
  if (state.promptVersionId) {
    chips.push({ key: 'promptVersionId', label: `version:${state.promptVersionId.slice(0, 8)}` });
  }
  for (const tag of state.tags ?? []) chips.push({ key: `tags:${tag}`, label: `tag:${quoteIfNeeded(tag)}` });
  for (const [k, v] of Object.entries(state.metadata ?? {})) {
    chips.push({ key: `metadata:${k}`, label: `${k}:${quoteIfNeeded(v)}` });
  }
  if (state.model) chips.push({ key: 'model', label: `model:${state.model}` });
  if (state.status) chips.push({ key: 'status', label: `status:${state.status}` });
  if (state.sessionId) chips.push({ key: 'sessionId', label: `session:${state.sessionId}` });
  if (state.rating) chips.push({ key: 'rating', label: `rating:${state.rating}` });
  if (state.source) chips.push({ key: 'source', label: `source:${state.source}` });
  if (state.label) chips.push({ key: 'label', label: `label:${quoteIfNeeded(state.label)}` });
  if (state.hasComment !== undefined) {
    chips.push({ key: 'hasComment', label: `comment:${state.hasComment ? 'yes' : 'no'}` });
  }
  if (state.minScore !== undefined) chips.push({ key: 'minScore', label: `score>${state.minScore}` });
  if (state.maxScore !== undefined) chips.push({ key: 'maxScore', label: `score<${state.maxScore}` });
  if (state.minLatencyMs !== undefined) chips.push({ key: 'minLatencyMs', label: `latency>${state.minLatencyMs}ms` });
  if (state.minCostUsd !== undefined) chips.push({ key: 'minCostUsd', label: `cost>${state.minCostUsd}` });
  if (state.minTokens !== undefined) chips.push({ key: 'minTokens', label: `tokens>${state.minTokens}` });

  return chips;
}

/**
 * Removes one chip from the state.
 *
 * @param state - The current filters.
 * @param key - A {@link Chip.key}.
 * @returns A new state without that filter. Removing `q` also drops its scope,
 *   since a scope with nothing to search is not a filter.
 */
export function removeChip(state: FilterState, key: string): FilterState {
  const next: FilterState = { ...state };

  if (key.startsWith('tags:')) {
    const tag = key.slice('tags:'.length);
    const rest = (next.tags ?? []).filter((t) => t !== tag);
    if (rest.length > 0) next.tags = rest;
    else delete next.tags;
    return next;
  }

  if (key.startsWith('metadata:')) {
    const metaKey = key.slice('metadata:'.length);
    const rest = { ...(next.metadata ?? {}) };
    delete rest[metaKey];
    if (Object.keys(rest).length > 0) next.metadata = rest;
    else delete next.metadata;
    return next;
  }

  if (key === 'q') {
    delete next.q;
    delete next.qIn;
    return next;
  }

  delete next[key as keyof FilterState];
  return next;
}

/** Every typed prefix the bar understands, for the suggestion list and the parser. */
export const FILTER_PREFIXES = [
  { prefix: 'prompt:', hint: 'any version of a prompt' },
  { prefix: 'tag:', hint: 'a trace tag' },
  { prefix: 'input:', hint: 'text in what was sent' },
  { prefix: 'output:', hint: 'text in what was answered' },
  { prefix: 'name:', hint: 'trace or span name only' },
  { prefix: 'model:', hint: 'a model name' },
  { prefix: 'status:', hint: 'ok, error or unset' },
  { prefix: 'session:', hint: 'a session id' },
  { prefix: 'rating:', hint: 'up, down or none' },
  { prefix: 'source:', hint: 'user, developer, end_user or api' },
  { prefix: 'label:', hint: 'an exact feedback label' },
  { prefix: 'comment:', hint: 'yes or no' },
  { prefix: 'score>', hint: 'minimum eval score' },
  { prefix: 'score<', hint: 'maximum eval score' },
  { prefix: 'latency>', hint: 'minimum latency in ms' },
  { prefix: 'cost>', hint: 'minimum cost in USD' },
  { prefix: 'tokens>', hint: 'minimum total tokens' },
] as const;

/**
 * The outcome of parsing one thing the person typed into the filter bar.
 *
 * `error` is the half that keeps a mistake visible: a value the filter does not
 * accept used to leave the state untouched while the box cleared itself, so the
 * whole string vanished with nothing on screen saying why.
 */
export interface FilterInputResult {
  /** The filters after applying the input — the identical object when nothing applied. */
  state: FilterState;
  /** Why nothing was applied, written for the person who typed it. `null` on success. */
  error: string | null;
}

/** Splits on whitespace, keeping a quoted run — `label:"needs review"` — in one piece. */
function tokenize(text: string): string[] {
  return text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/**
 * Whether a token names a filter on its own, rather than being ordinary words.
 *
 * Only used to decide whether a multi-token string is *two filters* or *one filter
 * with a spaced value*: `tag:my tag` has a second token that names nothing, so it
 * stays one tag called "my tag".
 */
function namesAFilter(token: string): boolean {
  if (/^meta\.[^:\s]+:.+$/.test(token)) return true;
  if (/^(score|latency|cost|tokens)[<>].+$/.test(token)) return true;
  const colon = token.indexOf(':');
  return colon > 0 && KNOWN_PREFIXES.has(token.slice(0, colon).toLowerCase()) && !!token.slice(colon + 1);
}

/** Applies exactly one expression — no whitespace splitting. See {@link applyFilterExpression}. */
function applyOne(state: FilterState, text: string): FilterInputResult {
  const next: FilterState = { ...state };
  const keep = (error: string): FilterInputResult => ({ state, error });

  const metaMatch = /^meta\.([^:\s]+):(.*)$/.exec(text);
  if (metaMatch) {
    const value = unquote(metaMatch[2]);
    if (!value) return keep(`meta.${metaMatch[1]}: needs a value after the colon.`);
    next.metadata = { ...(next.metadata ?? {}), [metaMatch[1]]: value };
    return { state: next, error: null };
  }

  const cmpMatch = /^(score|latency|cost|tokens)\s*([<>])\s*(.+)$/.exec(text);
  if (cmpMatch) {
    const [, field, op] = cmpMatch;
    const value = Number(unquote(cmpMatch[3]).replace(/ms$/, ''));
    if (!Number.isFinite(value)) return keep(`${field}${op} needs a number, for example ${field}${op}80.`);
    if (field === 'score') {
      if (op === '>') next.minScore = value;
      else next.maxScore = value;
      return { state: next, error: null };
    }
    // The other three only have a lower bound in the API, so `<` is not offered.
    if (op === '<') return keep(`${field} filters on a minimum only — try ${field}>${value}.`);
    if (field === 'latency') next.minLatencyMs = value;
    if (field === 'cost') next.minCostUsd = value;
    if (field === 'tokens') next.minTokens = value;
    return { state: next, error: null };
  }

  const colon = text.indexOf(':');
  if (colon > 0) {
    const prefix = text.slice(0, colon).toLowerCase();
    const value = unquote(text.slice(colon + 1));
    // A known prefix with nothing after it is an unfinished filter, not a search
    // for the literal text "tag:".
    if (KNOWN_PREFIXES.has(prefix) && !value) return keep(`${prefix}: needs a value after the colon.`);
    if (value) {
      switch (prefix) {
        case 'prompt':
          next.promptId = value;
          return { state: next, error: null };
        case 'version':
          next.promptVersionId = value;
          return { state: next, error: null };
        case 'tag':
          next.tags = [...new Set([...(next.tags ?? []), value])];
          return { state: next, error: null };
        case 'input':
        case 'output':
        case 'name':
          next.q = value;
          next.qIn = prefix;
          return { state: next, error: null };
        case 'model':
          next.model = value;
          return { state: next, error: null };
        case 'status':
          if (!STATUSES.has(value)) return keep('status: takes ok, error or unset.');
          next.status = value as SpanStatus;
          return { state: next, error: null };
        case 'session':
          next.sessionId = value;
          return { state: next, error: null };
        case 'rating':
          if (!RATINGS.has(value)) return keep('rating: takes up, down or none.');
          next.rating = value as RatingFilter;
          return { state: next, error: null };
        case 'source':
          if (!SOURCES.has(value)) return keep('source: takes user, developer, end_user or api.');
          next.source = value;
          return { state: next, error: null };
        case 'label':
          next.label = value;
          return { state: next, error: null };
        case 'comment':
          if (value !== 'yes' && value !== 'no') return keep('comment: takes yes or no.');
          next.hasComment = value === 'yes';
          return { state: next, error: null };
        default:
          break;
      }
    }
  }

  next.q = unquote(text);
  next.qIn = 'all';
  return { state: next, error: null };
}

/**
 * Applies what someone typed into the filter bar, and says why when it will not apply.
 *
 * Bare text with no recognised prefix becomes an unscoped `q`, which is what
 * someone typing a phrase from a conversation means. An unknown prefix is NOT
 * treated as a filter — `hello: world` is a sentence, not a `hello` filter — so
 * it falls through to `q` as well.
 *
 * Several filters typed in one go (`rating:down comment:yes`) are applied left to
 * right, but **only when every whitespace-separated token names a filter**. That
 * proviso is what keeps a spaced value whole: in `tag:my tag` the second token
 * names nothing, so the whole string stays one tag called "my tag", exactly as
 * before. Same for a phrase — `how do I rotate a key` is one `q`.
 *
 * @param state - The current filters.
 * @param input - What is in the box, e.g. `tag:prod`, `score>80`, `visit london`.
 * @returns The new state and `error: null`, or the unchanged state and the reason.
 */
export function applyFilterExpression(state: FilterState, input: string): FilterInputResult {
  const text = input.trim();
  if (!text) return { state, error: null };

  const tokens = tokenize(text);
  if (tokens.length > 1 && tokens.every(namesAFilter)) {
    let running = state;
    for (const token of tokens) {
      const result = applyOne(running, token);
      // One bad token fails the whole commit rather than applying a partial set —
      // half a filter applied while the box still holds all of it is its own trap.
      if (result.error) return { state, error: result.error };
      running = result.state;
    }
    return { state: running, error: null };
  }

  return applyOne(state, text);
}

/**
 * {@link applyFilterExpression} without the reason, for callers that only want the state.
 *
 * @param state - The current filters.
 * @param input - One expression, e.g. `tag:prod`, `score>80`, `visit london`.
 * @returns A new state, or the identical state when the input is blank or invalid.
 */
export function applyFilterInput(state: FilterState, input: string): FilterState {
  return applyFilterExpression(state, input).state;
}

/**
 * Renders filter state as the `filter` body the dataset `from-feedback`
 * endpoints take.
 *
 * A separate function from {@link filterStateToParams} because the wire shapes
 * genuinely differ: a query string repeats `tags` and brackets metadata keys,
 * while the JSON body takes an array and a nested object. Keeping both here
 * means the grammar stays the one place that knows either format.
 *
 * @param state - The current filters.
 * @returns A snake_case object with only the set filters present.
 */
export function filterStateToBody(state: FilterState): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (state.q) body.q = state.q;
  if (state.qIn && state.qIn !== 'all') body.q_in = state.qIn;
  if (state.promptId) body.prompt_id = state.promptId;
  if (state.promptVersionId) body.prompt_version_id = state.promptVersionId;
  if (state.tags?.length) body.tags = state.tags;
  if (state.metadata && Object.keys(state.metadata).length > 0) body.metadata = state.metadata;
  if (state.model) body.model = state.model;
  if (state.status) body.status = state.status;
  if (state.sessionId) body.session_id = state.sessionId;
  if (state.minScore !== undefined) body.min_score = state.minScore;
  if (state.maxScore !== undefined) body.max_score = state.maxScore;
  if (state.minLatencyMs !== undefined) body.min_latency_ms = state.minLatencyMs;
  if (state.minCostUsd !== undefined) body.min_cost_usd = state.minCostUsd;
  if (state.minTokens !== undefined) body.min_tokens = state.minTokens;
  if (state.rating) body.rating = state.rating;
  if (state.source) body.source = state.source;
  if (state.label) body.label = state.label;
  if (state.hasComment !== undefined) body.has_comment = state.hasComment;
  if (state.from) body.from = state.from;
  if (state.to) body.to = state.to;
  return body;
}
