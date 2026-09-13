import { z } from 'zod';
import { ToolVersion } from '@prisma/client';

// ── DB row type (Prisma inferred) ─────────────────────────────────────────────

/** Full row returned from the tool_versions table. */
export type ToolVersionRow = ToolVersion;

// ── Executor discriminated union ──────────────────────────────────────────────

/** definition-only executor: the customer's app runs the tool (TC1 stores the shape). */
const ClientExecutorSchema = z.object({ type: z.literal('client') });

const HttpHeaderSchema = z.object({ name: z.string().min(1), value: z.string() });

/**
 * Rejection messages for the two http-executor fields that were scaffolded for TC4 and
 * never wired to anything (phase-4 FAQ Q23, issue #458). Each names the mechanism that
 * does work, because a caller who gets only a rejection has no way to fix the tool.
 */
const ARG_MAPPING_UNSUPPORTED =
  'argMapping is never applied. Put {{arg.NAME}} in a query value, a header value or the URL instead — ' +
  'for example "query": [{ "name": "name", "value": "{{arg.city}}" }].';
const BODY_TEMPLATE_UNSUPPORTED =
  'bodyTemplate is never applied. The request body is the tool arguments as sent; ' +
  'shape it with a requestTransform instead.';

/**
 * declarative HTTP executor. TC1 validates SHAPE only; TC4 adds JS transform
 * syntax-check (requestTransform/responseTransform, FAQ Q10) and secret-ref existence (Q11).
 */
const HttpExecutorSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  headers: z.array(HttpHeaderSchema).default([]),
  query: z.array(HttpHeaderSchema).default([]),
  /**
   * Accepted only as an empty string, and never applied. See {@link BODY_TEMPLATE_UNSUPPORTED}.
   *
   * The body of a POST/PUT/PATCH call is the tool's arguments, or whatever a
   * `requestTransform` returns. A committed `bodyTemplate` shaped nothing, so the tool
   * sent the raw arguments while its own definition said otherwise.
   */
  bodyTemplate: z.string().max(0, { message: BODY_TEMPLATE_UNSUPPORTED }).optional(),
  /**
   * Accepted only as an empty list, and never applied. See {@link ARG_MAPPING_UNSUPPORTED}.
   *
   * Arguments reach an http request through `{{arg.NAME}}` templating in a header value,
   * a query value or the URL. A non-empty `argMapping` bound nothing, so the tool called
   * upstream with the argument missing and the span blamed the upstream for a 400 that
   * the tool's own configuration caused.
   *
   * The empty list still commits, and `.default([])` still writes it: `@acruxcoreai/sdk`
   * 0.13.0 and earlier type the field as required, so callers send `[]` whether they meant
   * to or not, and every http executor already stored carries the key. Dropping it from
   * newly committed JSON would change `specFingerprint` for tools that have not changed,
   * and `POST /tools/sync` would commit a new version for every one of them.
   */
  argMapping: z.array(z.unknown()).max(0, { message: ARG_MAPPING_UNSUPPORTED }).default([]),
  requestTransform: z.string().optional(),
  responseTransform: z.string().optional(),
  /**
   * A JS predicate deciding whether a completed call actually failed, for the case only
   * the tool's owner can judge: HTTP 200 carrying `{"error": "location not found"}`.
   *
   * Same contract and same `isolated-vm` sandbox as the two transforms — a source
   * defining `function transform(input) { ... }`, which is the name `compileTransform`
   * invokes; any other name commits fine and then fails at run time as a `transform`
   * warning. Syntax-checked at commit. It receives the
   * RAW `{ status, headers, body }`, deliberately BEFORE `responseTransform`, because a
   * transform is free to discard the very field that carries the error. It returns
   * `null` for a successful call, or `{ type?, message }` to declare a failure.
   */
  failureWhen: z.string().optional(),
  /**
   * JSON Schema the TRANSFORMED result must satisfy — the object the model actually
   * consumes, which is where the contract lives. Checked with the small subset checker
   * in `execute/result-schema.ts`, not a full validator.
   */
  resultSchema: z.record(z.unknown()).optional(),
  /**
   * What a `resultSchema` mismatch means. Absent reads as `warn`, because the declaration
   * may itself be the wrong one, and a check that cries wolf gets ignored — taking the
   * real signal down with it. A tool confident in its schema sets `error`.
   *
   * Deliberately `.optional()` rather than `.default('warn')`: a default would write the
   * key into every executor ever committed, including the overwhelming majority that
   * declare no result schema at all, silently changing stored JSON for a feature they do
   * not use.
   */
  resultSchemaSeverity: z.enum(['warn', 'error']).optional(),
});

/** Typed executor union: `{ type: 'client' }` | `{ type: 'http', ... }`. Re-consumed by TC4. */
export const ExecutorSchema = z.discriminatedUnion('type', [ClientExecutorSchema, HttpExecutorSchema]);
export type Executor = z.infer<typeof ExecutorSchema>;

// ── Provenance ────────────────────────────────────────────────────────────────

/**
 * Who authored a tool version. Mirrors the Prisma `ToolVersionSource` enum as a
 * string union so callers outside the API (SDKs, the web app) can use it without
 * importing generated Prisma types.
 */
export type ToolVersionSourceValue = 'code' | 'dashboard' | 'api';

/**
 * Sources a caller may claim on `POST /tools/:id/versions`. `code` is absent on
 * purpose: it means "derived from a decorated function" and is writable only by
 * `POST /tools/sync`, so a hand-rolled API call cannot forge code ownership and
 * make the dashboard warn about an edit that no deploy will ever supersede.
 */
export const RequestableToolVersionSourceSchema = z.enum(['dashboard', 'api']);

// ── Request body schemas ──────────────────────────────────────────────────────

/** Validated request body for POST /tools/:id/versions */
export const CreateToolVersionBodySchema = z.object({
  description: z.string().max(2000).optional(),
  changelog: z.string().max(2000).optional(),
  source: RequestableToolVersionSourceSchema.default('api'),
  parametersSchema: z.record(z.unknown()).refine((v) => v !== null && typeof v === 'object', {
    message: 'parametersSchema must be a JSON object',
  }),
  executor: ExecutorSchema,
});
export type CreateToolVersionDto = z.infer<typeof CreateToolVersionBodySchema>;

/** Validated query params for GET /tools/:id/versions */
export const ListToolVersionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListToolVersionsQueryDto = z.infer<typeof ListToolVersionsQuerySchema>;

// ── Service input type ────────────────────────────────────────────────────────

/** Input passed from ToolVersionsService into ToolVersionsRepository.create(). */
export interface CreateToolVersionInput {
  toolId: string;
  versionNumber: number;
  description?: string;
  changelog?: string;
  source: ToolVersionSourceValue;
  parametersSchema: unknown;
  executor: Executor;
  createdBy: string;
}

// ── Response types ────────────────────────────────────────────────────────────

/** Shape of a version in single-fetch and commit responses. */
export interface ToolVersionDetail {
  id: string;
  toolId: string;
  versionNumber: number;
  description: string | null;
  /** Release note for humans. Never read by the resolver, so never seen by the model. */
  changelog: string | null;
  source: ToolVersionSourceValue;
  parametersSchema: unknown;
  executor: Executor;
  createdBy: string;
  createdAt: string;
}

/** Shape of a version in list responses (parametersSchema/executor omitted for payload size). */
export interface ToolVersionListItem {
  id: string;
  toolId: string;
  versionNumber: number;
  description: string | null;
  changelog: string | null;
  source: ToolVersionSourceValue;
  createdBy: string;
  createdAt: string;
}
