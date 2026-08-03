import { z } from 'zod';
import { isBlockedUrlLiteral } from '../../tools/execute/safe-fetch';

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
  );

/** Validated create payload. */
export type CreateConnectionDto = z.infer<typeof CreateConnectionSchema>;

/**
 * Body for PATCH /gateway/connections/:id. All fields optional: update the label,
 * replace `config`, and/or rotate the key by supplying a new `apiKey`. Provider is
 * immutable and cannot be changed here. If `config.base_url` is supplied, it must
 * be a valid, non-SSRF-blocked URL — same check as `CreateConnectionSchema`.
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
    (data) => data.config?.['base_url'] === undefined || !isInvalidOrBlockedBaseUrl(data.config['base_url']),
    {
      message: 'config.base_url must be a valid URL that does not point at an internal or reserved address.',
      path: ['config', 'base_url'],
    },
  );

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
