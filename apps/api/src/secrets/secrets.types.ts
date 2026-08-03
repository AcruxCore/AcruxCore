import { z } from 'zod';

/** Masked secret shape returned by the API — never includes the value or ciphertext. */
export interface SecretDto {
  id: string;
  name: string;
  lastFour: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Secret names are referenced as `{{secret.NAME}}` in executors — constrain to a safe token. */
export const SECRET_NAME_PATTERN = /^[A-Z0-9_]{1,64}$/;

/** Request body schema for `POST /api/v1/secrets`. */
export const CreateSecretSchema = z.object({
  name: z.string().trim().regex(SECRET_NAME_PATTERN, 'name must match ^[A-Z0-9_]{1,64}$'),
  value: z.string().min(1, 'value must not be empty').max(8192),
});
/** Validated create-secret request body: `name` (token) + `value` (plaintext, encrypted before storage). */
export type CreateSecretDto = z.infer<typeof CreateSecretSchema>;

/** Request body schema for `PUT /api/v1/secrets/:id` (value rotation). */
export const UpdateSecretSchema = z.object({ value: z.string().min(1).max(8192) });
/** Validated rotate-secret request body: the new plaintext `value`. */
export type UpdateSecretDto = z.infer<typeof UpdateSecretSchema>;
