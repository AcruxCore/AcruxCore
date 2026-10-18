import { AcruxCoreApiError } from './errors';

/** HTTP verbs this client issues. */
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Options for a single request. */
export interface RequestOptions {
  /** JSON body. Omitted for GET/DELETE unless a body is genuinely needed. */
  body?: unknown;
  /** Query string parameters. `undefined` and `null` values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Extra request headers, e.g. the gateway's `x-trace-name`. */
  headers?: Record<string, string>;
}

/** A response body plus the headers a caller may need to read. */
export interface RawResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

/**
 * Appends `/api/v1` when the caller gave a bare host.
 *
 * Both forms are in the wild: the SDKs document `ACRUXCORE_BASE_URL` *with* the version
 * prefix, while someone configuring an MCP client by hand almost always pastes the
 * dashboard URL. Guessing wrong produces a 404 on every single tool call, which reads
 * like a broken server rather than a mistyped URL, so normalise instead.
 *
 * @param raw - Base URL as configured.
 * @returns A base URL ending in `/api/v1`, with no trailing slash.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (/\/api\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/api/v1`;
}

/**
 * Thin REST client for the AcruxCore API.
 *
 * Deliberately not the published `@acruxcoreai/sdk`: the MCP server needs endpoints the
 * SDK does not surface (eval rules, audit, gateway usage), needs the raw response
 * headers the gateway returns (`x-gateway-cost-usd`, `x-gateway-trace-id`), and must
 * pass an arbitrary caller-supplied bearer token per request when hosted inside the API.
 * Wrapping the SDK would mean fighting all three.
 */
export class AcruxCoreClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  /**
   * @param options.baseUrl - AcruxCore base URL, with or without the `/api/v1` suffix.
   * @param options.apiKey - An `acx_sk_…` API key.
   * @param options.timeoutMs - Per-request timeout. Defaults to 60s, which has to cover
   *   a gateway completion, not just a database read.
   * @param options.userAgent - Sent as `user-agent`, so API request logs can tell MCP
   *   traffic from SDK traffic.
   */
  constructor(options: { baseUrl: string; apiKey: string; timeoutMs?: number; userAgent?: string }) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.userAgent = options.userAgent ?? 'acruxcore-mcp-server';
  }

  /** The normalised base URL this client calls. */
  get resolvedBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Issues one request and returns the parsed body.
   *
   * @param method - HTTP verb.
   * @param path - Path below the base URL, starting with `/`.
   * @param options - Body, query and extra headers.
   * @returns The parsed JSON body, or `undefined` for a 204.
   * @throws {AcruxCoreApiError} On any non-2xx response, or a transport failure.
   */
  async request<T = unknown>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const { data } = await this.requestRaw<T>(method, path, options);
    return data;
  }

  /**
   * Issues one request and returns the body together with status and headers.
   *
   * Used by the gateway tools, where the interesting metadata (cost, provider, trace id)
   * arrives in `x-gateway-*` headers rather than the body.
   *
   * @param method - HTTP verb.
   * @param path - Path below the base URL, starting with `/`.
   * @param options - Body, query and extra headers.
   * @returns Parsed body, status and headers.
   * @throws {AcruxCoreApiError} On any non-2xx response, or a transport failure.
   */
  async requestRaw<T = unknown>(
    method: Method,
    path: string,
    options: RequestOptions = {},
  ): Promise<RawResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const label = `${method} ${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      'user-agent': this.userAgent,
      ...options.headers,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // A transport failure carries no status. Surfacing it with the URL is the
      // difference between "the server is down" and "the base URL is wrong", which are
      // the two things a user actually needs to tell apart here.
      const reason = err instanceof Error ? err.message : String(err);
      throw new AcruxCoreApiError(
        label,
        0,
        'NETWORK_ERROR',
        `Could not reach AcruxCore at ${url.origin}: ${reason}`,
      );
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw toApiError(label, response.status, parsed);
    }

    return { data: parsed as T, headers: response.headers, status: response.status };
  }

  /** GET shorthand. @see {@link request} */
  get<T = unknown>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  /** POST shorthand. @see {@link request} */
  post<T = unknown>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  /** PATCH shorthand. @see {@link request} */
  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  /** PUT shorthand. @see {@link request} */
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  /** DELETE shorthand. @see {@link request} */
  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

/**
 * Turns a failed response body into an {@link AcruxCoreApiError}.
 *
 * Handles the three shapes that actually come back: our own
 * `{ error: { code, message, … } }` envelope, a plain string (nginx or a proxy), and
 * anything else (fall back to the status).
 *
 * @param label - `METHOD /path` for the failed call.
 * @param status - HTTP status.
 * @param body - Parsed response body, whatever shape it turned out to be.
 * @returns The error to throw.
 */
function toApiError(label: string, status: number, body: unknown): AcruxCoreApiError {
  if (body && typeof body === 'object' && 'error' in body) {
    const envelope = (body as { error: unknown }).error;
    if (envelope && typeof envelope === 'object') {
      const { code, message, ...details } = envelope as Record<string, unknown>;
      return new AcruxCoreApiError(
        label,
        status,
        typeof code === 'string' ? code : `HTTP_${status}`,
        typeof message === 'string' ? message : `Request failed with status ${status}.`,
        details,
      );
    }
  }

  const message =
    typeof body === 'string' && body.trim().length > 0
      ? body.trim().slice(0, 500)
      : `Request failed with status ${status}.`;
  return new AcruxCoreApiError(label, status, `HTTP_${status}`, message);
}
