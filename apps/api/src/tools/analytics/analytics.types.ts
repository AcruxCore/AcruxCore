import { z } from 'zod';

/** Aggregated stats for one tool over the window. */
export interface ToolStat {
  toolName: string;
  calls: number;
  errorRate: number; // 0..1
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * Query params for GET /tools/analytics. Both bounds are optional ISO-8601
 * datetime strings; omitting either leaves that side of the window open.
 */
export const AnalyticsQuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/** Response envelope for GET /tools/analytics. */
export interface ToolAnalyticsResponse {
  data: ToolStat[];
}
