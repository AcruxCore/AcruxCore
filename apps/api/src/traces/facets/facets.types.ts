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
}
