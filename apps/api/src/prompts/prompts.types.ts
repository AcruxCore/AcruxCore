import { z } from 'zod';

/** Shape of a prompt returned in create/get/update responses. */
export interface PromptResponseDto {
  id: string;
  name: string;
  description: string | null;
  teamId: string;
  createdBy: string;
  createdAt: Date;
}

/** Shape of a prompt item in the list response (no teamId/createdBy). */
export interface PromptListItemDto {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

/** Paginated list response wrapper. */
export interface PromptListResponseDto {
  data: PromptListItemDto[];
  total: number;
  page: number;
  limit: number;
}

/** Zod schema for POST /prompts body. */
export const CreatePromptSchema = z.object({
  name: z
    .string({ required_error: 'name is required.' })
    .trim()
    .min(1, 'name must not be empty.')
    .max(255, 'name must be 255 characters or fewer.'),
  description: z
    .string()
    .max(2000, 'description must be 2000 characters or fewer.')
    .optional(),
});

export type CreatePromptDto = z.infer<typeof CreatePromptSchema>;

/** Zod schema for PATCH /prompts/:id body. At least one field required. */
export const UpdatePromptSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'name must not be empty.')
      .max(255, 'name must be 255 characters or fewer.')
      .optional(),
    description: z
      .string()
      .max(2000, 'description must be 2000 characters or fewer.')
      .nullable()
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'At least one of name or description must be provided.',
  });

export type UpdatePromptDto = z.infer<typeof UpdatePromptSchema>;

/** Zod schema for GET /prompts query params. */
export const ListPromptsQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListPromptsQuery = z.infer<typeof ListPromptsQuerySchema>;
