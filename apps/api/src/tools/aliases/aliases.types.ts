import { z } from 'zod';
import { ToolAlias } from '@prisma/client';

/** Full row returned from the tool_aliases table. */
export type ToolAliasRow = ToolAlias;

/** Resolved alias with its target version number, for API responses. */
export interface AliasDetail {
  id: string;
  alias: string;
  versionId: string;
  versionNumber: number;
  updatedAt: string;
}

/** Validated request body for POST /tools/:id/aliases/:alias/promote */
export const PromoteToolAliasBodySchema = z.object({
  version_number: z
    .number({ required_error: 'version_number is required' })
    .int('version_number must be an integer')
    .min(1, 'version_number must be >= 1'),
});

/** DTO for promoting/rolling back a tool alias. */
export type PromoteToolAliasDto = z.infer<typeof PromoteToolAliasBodySchema>;
