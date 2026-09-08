import { z } from 'zod';

/**
 * Which list a saved view belongs to. A plain enum at the boundary rather than a
 * database enum, so adding a third surface is a code change and not a migration.
 */
export const ViewSurfaceSchema = z.enum(['traces', 'feedback']);

/** The list a saved view filters. */
export type ViewSurface = z.infer<typeof ViewSurfaceSchema>;

/**
 * Ceiling on a saved view's stored query string. A view is a handful of filters;
 * anything near this is a pasted URL with pagination and junk in it, and storing
 * it would make the view mean something different every time the page changed.
 */
export const MAX_VIEW_QUERY_LENGTH = 2000;

/** Query params for GET /trace-views: which surface's views to list. */
export const ListViewsQuerySchema = z.object({
  surface: ViewSurfaceSchema,
});
export type ListViewsQuery = z.infer<typeof ListViewsQuerySchema>;

/**
 * Body for POST /trace-views. `query` is the raw filter query string, stored
 * verbatim — a leading `?` is tolerated and stripped, since the obvious thing to
 * paste is `location.search`.
 */
export const CreateViewSchema = z.object({
  surface: ViewSurfaceSchema,
  name: z.string().trim().min(1).max(100),
  query: z
    .string()
    .max(MAX_VIEW_QUERY_LENGTH)
    .transform((v) => (v.startsWith('?') ? v.slice(1) : v)),
});
export type CreateViewDto = z.infer<typeof CreateViewSchema>;

/**
 * Body for PATCH /trace-views/:id. Both fields optional so a view can be renamed
 * without resending its query, or re-pointed without renaming it; the service
 * rejects a body that changes nothing.
 */
export const UpdateViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  query: z
    .string()
    .max(MAX_VIEW_QUERY_LENGTH)
    .transform((v) => (v.startsWith('?') ? v.slice(1) : v))
    .optional(),
});
export type UpdateViewDto = z.infer<typeof UpdateViewSchema>;

/** One saved view as the API returns it. */
export interface SavedViewDto {
  id: string;
  surface: string;
  name: string;
  query: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
