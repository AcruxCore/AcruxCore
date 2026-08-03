import { z } from 'zod';

/**
 * What the API returns when listing keys — full key value is never included in the list.
 * `lastFour` lets users identify which key is which without exposing the secret.
 */
export interface ApiKeyListItemDto {
  id: string;
  name: string | null;
  lastFour: string;
  createdAt: Date;
}

/**
 * What the API returns immediately after creating a key.
 * This is the ONLY response that includes the full key value.
 */
export interface ApiKeyCreatedDto {
  id: string;
  key: string;
  name: string | null;
  createdAt: Date;
}

/** Zod schema for POST /api-keys body. `name` is optional. */
export const CreateApiKeySchema = z.object({
  name: z.string().max(100, 'Name must be 100 characters or fewer.').optional(),
});

export type CreateApiKeyDto = z.infer<typeof CreateApiKeySchema>;
