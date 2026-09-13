/**
 * One deployment the gateway tried, as `callWithFallback` records it on the span's
 * `trail` attribute. Every field is optional because a trail written before a field
 * existed is still in the database and still has to render.
 */
export interface TrailEntry {
  modelId?: string;
  model?: string;
  upstreamModel?: string;
  attempts?: number;
  error?: string;
  errorMessage?: string;
  retriedAfter?: { error?: string; errorMessage?: string };
}

/** One model's turn, ready to render: what was called, how often, and how it ended. */
export interface AttemptRow {
  model: string;
  upstreamModel?: string;
  attempts: number;
  /** `answered`, or `failed 401` — the provider status that ended this model's turn. */
  outcome: string;
  /**
   * What the provider itself said, when it said anything. A status code tells a reader
   * that an attempt failed; only this tells them why, which is the difference between
   * "401" and "Incorrect API key provided".
   *
   * For a model that answered only after being retried, this is what its earlier calls
   * were failing on — so a rescued call still says what went wrong.
   */
  errorMessage?: string;
  /** The status those earlier calls returned, when this model answered after retries. */
  retriedAfterStatus?: string;
}

/** A readable account of a multi-attempt call: the one-line verdict and the per-model rows. */
export interface AttemptSummary {
  /** e.g. `retried once, then fell back to mistral-small`. */
  verdict: string;
  rows: AttemptRow[];
}

/** `once` / `twice` / `3 times` — "1 times" reads like a bug in the panel. */
function times(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${n} times`;
}

/** A name for a model whose trail entry predates the `model` field. */
function nameOf(entry: TrailEntry): string {
  if (entry.model) return entry.model;
  if (entry.modelId) return entry.modelId.slice(0, 8);
  return 'unknown model';
}

/**
 * Turns a span's `attempts` count and `trail` into something a reader can act on.
 *
 * The raw pair does not answer the two questions anyone actually has — was this a retry
 * or a fallback, and which model ended up answering — because the trail identifies models
 * by uuid and the count is a chain-wide total. A retry is repeated calls to one entry; a
 * fallback is more than one entry. Both can happen in one call, and this separates them.
 *
 * @param attempts - The span's chain-wide attempt total, used only to read a one-entry
 *   trail written before per-entry counts existed.
 * @param trail - The span's `trail` attribute, one entry per model tried, in order.
 * @returns The verdict and rows, or `null` when a single attempt succeeded and there is
 *   nothing to explain.
 */
export function summarizeAttempts(
  attempts: number | undefined,
  trail: unknown[] | undefined,
): AttemptSummary | null {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const entries = trail as TrailEntry[];

  const rows: AttemptRow[] = entries.map((entry) => ({
    model: nameOf(entry),
    upstreamModel: entry.upstreamModel,
    // A one-entry trail with no per-entry count is wholly accounted for by the total.
    attempts: entry.attempts ?? (entries.length === 1 && typeof attempts === 'number' ? attempts : 1),
    outcome: entry.error ? `failed ${entry.error}` : 'answered',
    errorMessage: entry.errorMessage ?? entry.retriedAfter?.errorMessage,
    retriedAfterStatus: entry.error ? undefined : entry.retriedAfter?.error,
  }));

  const retries = rows.reduce((sum, row) => sum + Math.max(0, row.attempts - 1), 0);
  const last = rows[rows.length - 1];
  const fellBack = rows.length > 1;
  if (!fellBack && retries === 0) return null;

  let verdict: string;
  if (!fellBack) {
    verdict = `retried ${times(retries)}`;
  } else if (last.outcome !== 'answered') {
    verdict = `fell back to ${last.model}, which failed too`;
  } else if (retries === 0) {
    verdict = `fell back to ${last.model}, no retry first`;
  } else {
    verdict = `retried ${times(retries)}, then fell back to ${last.model}`;
  }

  return { verdict, rows };
}
