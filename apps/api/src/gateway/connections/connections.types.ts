import type { ListedModel } from '../providers/list-models';
import { z } from 'zod';
import { isBlockedUrlLiteral } from '../../tools/execute/safe-fetch';

/**
 * Extra HTTP headers an `openai_compatible` connection sends on every provider call
 * (issue #790). Some OpenAI-compatible hosts refuse a call without one of their own — OpenCode
 * Go rejects any request that lacks `x-opencode-session` — so without this such a host could
 * not sit behind the gateway at all.
 *
 * Values are stored as plain connection config, readable by every team member who can list
 * the connection, so they are for routing and identification, never for secrets: the
 * provider key belongs in `apiKey`, which is encrypted. That is why every header that
 * carries auth is refused (phase-2 FAQ Q32).
 */

/** Most headers one connection may set; real providers need one or two. */
export const MAX_CONNECTION_HEADERS = 20;

/**
 * Headers a connection may not set, lower-cased. Two kinds:
 * - auth headers: the connection's encrypted key is the one credential, and a second,
 *   plaintext credential in config would leak through every connection listing;
 * - headers the gateway or `fetch` own: framing, encoding and the request's own host.
 */
const DENIED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'host',
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'accept-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
]);

/**
 * A name that says it carries a credential: vendor key headers such as `x-goog-api-key`,
 * `x-auth-token` or `ocp-apim-subscription-key`. A fixed list cannot name every vendor's
 * header, so the words are matched instead. `session` is deliberately absent: OpenCode Go's
 * `x-opencode-session` is the routing header this feature exists for.
 */
const CREDENTIAL_NAME = /auth|token|secret|passw|api[-_]?key|apikey|credential|signature|subscription-key|cookie/i;

/** An RFC 9110 header name (a "token"). */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Visible ASCII, space and tab only: no CR/LF, so a value cannot inject a header. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** One header name: an HTTP token, not denied, and not a credential by its name. */
export const ConnectionHeaderNameSchema = z
  .string()
  .max(100, 'A header name must be 100 characters or fewer.')
  .regex(HEADER_NAME, 'A header name may hold only letters, digits and !#$%&\'*+.^_`|~-')
  .refine((name) => !DENIED_HEADERS.has(name.toLowerCase()), {
    message:
      'This header cannot be set on a connection: auth headers belong in apiKey, and the gateway sets the rest itself.',
  })
  .refine((name) => !CREDENTIAL_NAME.test(name), {
    message:
      'This header looks like it carries a credential. Connection headers are readable by every team member, so put the key in apiKey instead.',
  });

/** One header value: printable ASCII of at most 1024 characters. */
export const ConnectionHeaderValueSchema = z
  .string()
  .max(1024, 'A header value must be 1024 characters or fewer.')
  .regex(HEADER_VALUE, 'A header value may hold only printable ASCII characters.');

/**
 * `config.headers`: a flat name → value object of at most {@link MAX_CONNECTION_HEADERS}
 * entries, see the two entry schemas. Names are case-insensitive in HTTP, so two names
 * that differ only in case are refused: `fetch` would send them as one comma-joined value.
 */
export const ConnectionHeadersSchema = z
  .record(ConnectionHeaderNameSchema, ConnectionHeaderValueSchema)
  .refine((headers) => Object.keys(headers).length <= MAX_CONNECTION_HEADERS, {
    message: `A connection may set at most ${MAX_CONNECTION_HEADERS} headers.`,
  })
  .superRefine((headers, ctx) => {
    const seen = new Set<string>();
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (seen.has(lower)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `Header ${lower} is set twice. HTTP header names ignore case, so keep one.`,
        });
      }
      seen.add(lower);
    }
  });

/**
 * Validates `config.headers` and adds its issues under `config.headers`. `null` is allowed
 * only on update, where it removes the headers (JSON Merge Patch).
 */
function checkHeaders(headers: unknown, ctx: z.RefinementCtx, allowNull: boolean): void {
  if (headers === undefined || (allowNull && headers === null)) return;
  const parsed = ConnectionHeadersSchema.safeParse(headers);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: ['config', 'headers', ...issue.path] });
  }
}

/** The supported provider kinds; mirrors the Prisma `provider_kind` enum. */
export const ProviderKindSchema = z.enum(['openai', 'anthropic', 'openai_compatible', 'gemini']);

/** A provider kind value (`'openai' | 'anthropic' | 'openai_compatible' | 'gemini'`). */
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * True when `base_url` fails plain URL validation, or resolves (as a literal IP)
 * to a blocked SSRF target. A hostname base_url always passes here — the real,
 * DNS-resolving guard is applied at request time by `createSsrfSafeDispatcher`.
 */
function isInvalidOrBlockedBaseUrl(baseUrl: unknown): boolean {
  return !z.string().url().safeParse(baseUrl).success || isBlockedUrlLiteral(baseUrl as string);
}

/**
 * Provider kinds whose adapter actually reads `creds.baseUrl` at request time
 * (`openai.adapter.ts`, `gemini.adapter.ts`). `anthropic` is deliberately excluded:
 * `anthropic.adapter.ts` never reads `creds.baseUrl` and always calls its hardcoded
 * host, so an anthropic connection's `config.base_url` (if present at all) is inert —
 * validating it as an SSRF risk would only produce spurious rejections for a field
 * that is never used to make a request.
 */
const BASE_URL_AWARE_PROVIDERS: ReadonlySet<ProviderKind> = new Set([
  'openai',
  'openai_compatible',
  'gemini',
]);

/**
 * Body for POST /gateway/connections. `config` defaults to `{}`. When
 * `provider === 'openai_compatible'`, `config.base_url` is required and must be a
 * valid, non-SSRF-blocked URL. For every other provider, `config.base_url` is
 * optional (it overrides that provider's hardcoded default), but if supplied it
 * must pass the same check — enforced by the refines below (error path points at
 * `config.base_url`).
 */
export const CreateConnectionSchema = z
  .object({
    provider: ProviderKindSchema,
    label: z
      .string()
      .min(1, 'Label is required.')
      .max(200, 'Label must be 200 characters or fewer.'),
    apiKey: z.string().min(1, 'API key is required.'),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (data) => data.provider !== 'openai_compatible' || !isInvalidOrBlockedBaseUrl(data.config['base_url']),
    {
      message: 'openai_compatible connections require config.base_url to be a valid, non-internal URL.',
      path: ['config', 'base_url'],
    },
  )
  .refine(
    (data) =>
      !BASE_URL_AWARE_PROVIDERS.has(data.provider) ||
      data.config['base_url'] === undefined ||
      !isInvalidOrBlockedBaseUrl(data.config['base_url']),
    {
      message: 'config.base_url must be a valid URL that does not point at an internal or reserved address.',
      path: ['config', 'base_url'],
    },
  )
  .superRefine((data, ctx) => {
    // Extra headers exist for OpenAI-compatible hosts that demand their own (issue #790).
    if (data.config['headers'] !== undefined && data.provider !== 'openai_compatible') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'config.headers is supported only on openai_compatible connections.',
        path: ['config', 'headers'],
      });
      return;
    }
    checkHeaders(data.config['headers'], ctx, false);
  });

/** Validated create payload. */
export type CreateConnectionDto = z.infer<typeof CreateConnectionSchema>;

/**
 * Body for PATCH /gateway/connections/:id. All fields optional: update the label,
 * amend `config`, and/or rotate the key by supplying a new `apiKey`. Provider is
 * immutable and cannot be changed here. If `config.base_url` is supplied, it must
 * be a valid, non-SSRF-blocked URL — same check as `CreateConnectionSchema`.
 *
 * `config` follows JSON Merge Patch (RFC 7396): a key you send is set, a key you omit
 * is left alone, and a key sent as `null` is **removed**. Plain merge without the null
 * rule reads well until something has to be taken away — a `base_url` pointing at a
 * decommissioned host could then never be cleared, because `{}` changed nothing and
 * `""` failed validation, leaving delete-and-recreate as the only route, which
 * `delete()` refuses with 409 while any model still binds the credential.
 *
 * Unlike `CreateConnectionSchema`, this check cannot be scoped to
 * `BASE_URL_AWARE_PROVIDERS`: `provider` is immutable and therefore not part of this
 * payload at all, so the schema has no way to know which provider kind an update
 * targets without a DB round-trip (out of scope for a Zod schema; the controller only
 * calls `safeParse(req.body)`, with no connection lookup at that point). Validating
 * `base_url` unconditionally here is the conservative choice: it can spuriously reject
 * an anthropic connection's incidental `config.base_url`, but the alternative — skipping
 * the check because the provider is unknown — would risk letting an SSRF-risky
 * `base_url` through on an actual openai/gemini update, which is the failure mode this
 * whole validator exists to prevent.
 */
export const UpdateConnectionSchema = z
  .object({
    label: z
      .string()
      .min(1, 'Label must not be empty.')
      .max(200, 'Label must be 200 characters or fewer.')
      .optional(),
    apiKey: z.string().min(1, 'API key must not be empty.').optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    // `null` is a removal, not a value, so it skips the URL check — without this the
    // only way to express "remove base_url" is rejected by the validator meant to
    // police its contents.
    (data) =>
      data.config?.['base_url'] === undefined ||
      data.config['base_url'] === null ||
      !isInvalidOrBlockedBaseUrl(data.config['base_url']),
    {
      message: 'config.base_url must be a valid URL that does not point at an internal or reserved address.',
      path: ['config', 'base_url'],
    },
  )
  // The provider is not in this payload, so the openai_compatible-only rule is enforced in
  // ConnectionsService.update, after the connection is loaded.
  .superRefine((data, ctx) => checkHeaders(data.config?.['headers'], ctx, true));

/** Validated update payload. */
export type UpdateConnectionDto = z.infer<typeof UpdateConnectionSchema>;

/**
 * Masked connection shape returned by every endpoint. Deliberately omits the
 * encrypted bytes and the plaintext key — only `keyLastFour` identifies the key.
 */
export interface ProviderConnectionDto {
  id: string;
  provider: ProviderKind;
  label: string;
  keyLastFour: string;
  config: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Response of GET /gateway/connections/:id/models. A provider failure is reported in
 * the body rather than as an error status, the same as the model Test call, because
 * the caller (the New model dialog) falls back to typing the id either way.
 */
export interface ConnectionModelsResult {
  ok: boolean;
  /**
   * Models the credential can call, sorted by id. Ids only, no prices: the user types
   * a model's prices when registering it. Present when `ok`.
   */
  models?: ListedModel[];
  /** Why the list could not be read. Present when not `ok`. */
  error?: string;
}
