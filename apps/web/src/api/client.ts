/** Base path for the versioned API. Served same-origin via the Vite dev proxy. */
const BASE = '/api/v1';

/**
 * A typed error thrown for any non-2xx API response.
 *
 * Carries the API's `error.code` and `message`, the HTTP `status`, and any
 * extra fields the endpoint returned (e.g. `missing[]` on a render 400).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Optional hook invoked whenever a request returns 401, for global sign-out. */
let onUnauthorized: (() => void) | null = null;

/**
 * Register a callback fired on any 401 response (used by AuthProvider to clear
 * state and redirect to login).
 *
 * @param cb - Handler to run on 401, or `null` to clear.
 */
export function setUnauthorizedHandler(cb: (() => void) | null): void {
  onUnauthorized = cb;
}

/** A single query-param value: scalar, a repeatable array, or a bracket-notation object. */
export type ApiQueryValue = string | number | string[] | Record<string, string> | undefined;
/** The full query-param map accepted by {@link api}. */
export type ApiQuery = Record<string, ApiQueryValue>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: ApiQuery;
}

/**
 * Perform a JSON API request against `/api/v1`.
 *
 * Authentication rides along as the httpOnly session cookie — nothing is
 * attached here. On a non-2xx response
 * the `{ error: { code, message, ...extra } }` envelope is parsed into an
 * {@link ApiError}. A 401 additionally triggers the global unauthorized handler.
 *
 * Query serialization: scalars become `k=v`; arrays become repeated `k=v1&k=v2`
 * (matches the API's repeatable `?tags=` filter); objects become bracket-notation
 * `k[sub]=v` (matches `?metadata[env]=prod`). Empty/undefined values are dropped.
 *
 * @param path - Path beneath `/api/v1` (leading slash required), e.g. `/prompts`.
 * @param opts - Method, JSON body, and query params.
 * @returns The parsed JSON response body typed as `T` (or `undefined` for 204).
 * @throws {ApiError} On any non-2xx response.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = opts;

  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        for (const item of v) qs.append(k, item);
      } else if (typeof v === 'object') {
        for (const [subKey, subVal] of Object.entries(v)) {
          if (subVal !== undefined && subVal !== '') qs.set(`${k}[${subKey}]`, subVal);
        }
      } else {
        qs.set(k, String(v));
      }
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // The session is an httpOnly cookie, so there is no token for this layer to
    // attach — the browser sends it. `same-origin` is already the default; it is
    // spelled out because it is now load-bearing rather than incidental.
    credentials: 'same-origin',
  });

  if (res.status === 401 && onUnauthorized) onUnauthorized();

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const err = (data && data.error) || {};
    const { code, message, ...extra } = err as {
      code?: string;
      message?: string;
      [k: string]: unknown;
    };
    throw new ApiError(
      res.status,
      code || 'UNKNOWN',
      message || `Request failed (${res.status})`,
      extra,
    );
  }

  return data as T;
}
