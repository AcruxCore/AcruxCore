import { z } from 'zod';
import { TOOL_NAME_PATTERN } from '../tools.types';
import { ExecutorSchema, type ToolVersionSourceValue } from '../versions/versions.types';

/**
 * Validated request body for `POST /tools/sync`.
 *
 * Unlike `POST /tools/:id/versions` this identifies the tool by NAME, because the
 * caller is a decorated function in someone's source file and has no id to hand.
 *
 * `source` accepts `code` here — this is the only endpoint that may claim code
 * ownership, and the whole ownership-warning mechanism rests on that staying true.
 */
export const SyncToolBodySchema = z.object({
  name: z
    .string({ required_error: 'name is required.' })
    .trim()
    .regex(TOOL_NAME_PATTERN, 'name must match ^[a-zA-Z0-9_-]{1,64}$'),
  description: z.string().max(2000).optional(),
  changelog: z.string().max(2000).optional(),
  parametersSchema: z.record(z.unknown()).refine((v) => v !== null && typeof v === 'object', {
    message: 'parametersSchema must be a JSON object',
  }),
  executor: ExecutorSchema,
  alias: z.string().trim().min(1).max(64).default('production'),
  source: z.enum(['code', 'dashboard', 'api']).default('code'),
});
export type SyncToolDto = z.infer<typeof SyncToolBodySchema>;

/** Response shape for `POST /tools/sync`. */
export interface SyncToolResult {
  /** The tool this spec belongs to, created by this call if the name was new. */
  toolId: string;
  /** The version the alias points at after the call — the NEW one if `committed`. */
  versionNumber: number;
  /** False when the submitted spec already matched the live version. */
  committed: boolean;
  /** The alias that now points at `versionNumber`. */
  alias: string;
  /**
   * Set only when a commit happened AND the superseded version's `source` was
   * `dashboard` — a hand edit has stopped being live. The SDKs' warning trigger.
   */
  supersededSource?: ToolVersionSourceValue;
}
