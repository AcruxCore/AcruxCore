import { z } from 'zod';

/** Body for PUT /traces/settings — toggle the payload-capture default. */
export const UpdateTraceSettingsSchema = z.object({
  capturePayloads: z.boolean({
    required_error: 'capturePayloads is required.',
    invalid_type_error: 'capturePayloads must be a boolean.',
  }),
});

/** Validated update payload. */
export type UpdateTraceSettingsDto = z.infer<typeof UpdateTraceSettingsSchema>;

/**
 * The settings shape returned by GET/PUT. `updatedAt` is null until the team's row
 * has ever been written (lazy default).
 */
export interface TraceSettingsDto {
  capturePayloads: boolean;
  updatedAt: Date | null;
}
