import { PromptVersionTool } from '@prisma/client';

/** A tool to attach at commit time. Resolves by alias unless pinnedVersionNumber is given. */
export interface AttachmentInput {
  toolId: string;
  alias?: string;
  pinnedVersionNumber?: number;
}

/** A hydrated attachment row joined to its tool. */
export interface AttachmentRow {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string | null;
  aliasName: string;
  pinnedVersionId: string | null;
  position: number;
}

/** Persisted attachment (post-resolution of any pin) for insertion. */
export interface AttachmentCreateData {
  toolId: string;
  aliasName: string;
  pinnedVersionId: string | null;
  position: number;
}

/** Raw `prompt_version_tools` row, as returned by Prisma. */
export type PromptVersionToolRow = PromptVersionTool;
