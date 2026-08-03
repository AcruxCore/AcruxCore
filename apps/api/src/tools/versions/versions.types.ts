import { z } from 'zod';
import { ToolVersion } from '@prisma/client';

// ── DB row type (Prisma inferred) ─────────────────────────────────────────────

/** Full row returned from the tool_versions table. */
export type ToolVersionRow = ToolVersion;

// ── Executor discriminated union ──────────────────────────────────────────────

/** definition-only executor: the customer's app runs the tool (TC1 stores the shape). */
const ClientExecutorSchema = z.object({ type: z.literal('client') });

const HttpHeaderSchema = z.object({ name: z.string().min(1), value: z.string() });
const ArgMappingSchema = z.object({
  arg: z.string().min(1),
  in: z.enum(['query', 'path', 'header', 'body']),
  path: z.string().optional(),
});

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
  bodyTemplate: z.string().optional(),
  argMapping: z.array(ArgMappingSchema).default([]),
  requestTransform: z.string().optional(),
  responseTransform: z.string().optional(),
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
