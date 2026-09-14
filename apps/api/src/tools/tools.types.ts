import { z } from 'zod';
import { Tool } from '@prisma/client';

/**
 * Where one of a tool's aliases currently points. Returned inline on the tool so a
 * caller learns what `production` serves without a second request per tool.
 */
export interface ToolAliasTargetDto {
  alias: string;
  versionNumber: number;
}

/**
 * Whether a tool can actually be called, and what a caller gets when it is.
 *
 * A tool's name and description say nothing about this. Creating a tool makes a shell
 * with no version, and a shell resolves to nothing — so a prompt bound to one silently
 * runs with one tool fewer than its author intended. Every surface that lists tools
 * needs to distinguish the two states, and doing it with a versions fetch per row is
 * what stopped it being done at all.
 */
export interface ToolReadinessDto {
  /** True once a version exists and `production` points at one — the resolvable state. */
  callable: boolean;
  /** How many versions have been committed. Zero means the tool is a name only. */
  versionCount: number;
  /** Highest committed version number, or null when there are none. */
  latestVersionNumber: number | null;
  /**
   * Executor of the version `production` currently serves — who runs the call. Null
   * when the tool is not callable. Production's, not the latest version's, because
   * that is what an unqualified `tool_ref` and a newly connected binding both resolve to.
   */
  executorType: 'client' | 'http' | null;
  /** Every alias on the tool with the version it points at, `production` first. */
  aliases: ToolAliasTargetDto[];
}

/** HTTP response shape for a single tool (the mutable shell plus its readiness). */
export interface ToolResponseDto extends ToolReadinessDto {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  createdBy: string;
  createdAt: Date;
}

/** Paginated list envelope for tools. */
export interface ToolListResponseDto {
  data: ToolResponseDto[];
  total: number;
  page: number;
  limit: number;
}

/** A tool with no versions — the state every tool starts in. */
export const NOT_CALLABLE: ToolReadinessDto = {
  callable: false,
  versionCount: 0,
  latestVersionNumber: null,
  executorType: null,
  aliases: [],
};

/**
 * Maps a Prisma Tool row to the API response shape.
 *
 * @param row - The tool row.
 * @param readiness - Its readiness, from {@link ToolsRepository.readinessFor}. Defaults
 *   to {@link NOT_CALLABLE}, which is the honest answer for a tool that was just created.
 */
export function toToolResponseDto(row: Tool, readiness: ToolReadinessDto = NOT_CALLABLE): ToolResponseDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    teamId: row.teamId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    ...readiness,
  };
}

/** The function name the LLM sees — constrained for OpenAI/Anthropic/Gemini compatibility. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Zod schema for POST /tools body. */
export const CreateToolSchema = z.object({
  name: z
    .string({ required_error: 'name is required.' })
    .trim()
    .regex(TOOL_NAME_PATTERN, 'name must match ^[a-zA-Z0-9_-]{1,64}$'),
  description: z.string().max(2000, 'description must be 2000 characters or fewer.').optional(),
});
export type CreateToolDto = z.infer<typeof CreateToolSchema>;

/** Zod schema for PATCH /tools/:id body. At least one field required. */
export const UpdateToolSchema = z
  .object({
    name: z.string().trim().regex(TOOL_NAME_PATTERN, 'name must match ^[a-zA-Z0-9_-]{1,64}$').optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'At least one of name or description must be provided.',
  });
export type UpdateToolDto = z.infer<typeof UpdateToolSchema>;

/** Zod schema for GET /tools query params. */
export const ListToolsQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListToolsQuery = z.infer<typeof ListToolsQuerySchema>;
