import { z } from 'zod';
import type { DetailedResolvedTool } from '../resolver';

/**
 * Validated request body for `POST /tools/resolve`.
 *
 * A batch of refs rather than one, because the caller is a tool loop about to start and
 * it knows all of its tools up front — five tools should cost one request. The cap of 50
 * exists so a malformed caller cannot turn one request into hundreds of sequential
 * lookups.
 *
 * A ref names one build in one of two ways: an `alias` to follow (defaulting to
 * `production`), or a `version` to pin. Both on one ref is a 400 rather than a precedence
 * rule, because a caller sending both has two different builds in mind and guessing which
 * would run the wrong tool silently.
 */
export const ResolveToolsBodySchema = z.object({
  refs: z
    .array(
      z
        .object({
          name: z.string().trim().min(1, 'each ref needs a name.'),
          alias: z.string().trim().min(1).max(64).optional(),
          version: z.number().int().positive().optional(),
        })
        .refine((r) => !(r.alias !== undefined && r.version !== undefined), {
          message: 'a ref takes either alias or version, not both.',
        }),
    )
    .min(1, 'refs must contain at least one ref.')
    .max(50, 'refs may contain at most 50 refs.'),
});
export type ResolveToolsDto = z.infer<typeof ResolveToolsBodySchema>;

/** Response envelope for `POST /tools/resolve`. */
export interface ResolveToolsResponse {
  data: DetailedResolvedTool[];
}
