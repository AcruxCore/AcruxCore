import { z } from 'zod';

/** Query params for GET /traces/facets/values. `key` must be non-blank. */
export const FacetValuesQuerySchema = z.object({
  key: z.string().trim().min(1, 'key is required.'),
});
/** Parsed query params for GET /traces/facets/values. */
export type FacetValuesQuery = z.infer<typeof FacetValuesQuerySchema>;

/** Response for GET /traces/facets. */
export interface TraceFacets {
  tags: string[];
  metadataKeys: string[];
  /** Distinct resolved `llm` span models seen for the team (see `facets.repository.ts`'s `listModels`). */
  models: string[];
  /**
   * Distinct `errorCode` slugs the team's tools have declared, for the `error_code:`
   * filter. Unlike `error_type`, these are the team's own words, so they can only come
   * from what has been recorded.
   */
  errorCodes: string[];
}
