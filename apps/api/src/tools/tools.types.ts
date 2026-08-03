import { z } from 'zod';
import { Tool } from '@prisma/client';

/** HTTP response shape for a single tool (the mutable shell). */
export interface ToolResponseDto {
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

/** Maps a Prisma Tool row to the API response shape. */
export function toToolResponseDto(row: Tool): ToolResponseDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    teamId: row.teamId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
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
