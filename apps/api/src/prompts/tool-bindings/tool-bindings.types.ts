import { z } from 'zod';

/**
 * Validated body for both binding endpoints. Exactly one of the three fields must
 * be present — they are the three states a grid cell can hold, and accepting more
 * than one would leave the server guessing which the author meant.
 *
 * `off` is only meaningful for an alias-scoped binding: it means "this alias
 * deliberately has no such tool", which exists solely to contradict a default
 * that does hold it. The controller rejects it on the default endpoint, where
 * there is nothing to contradict.
 */
export const SetBindingBodySchema = z
  .object({
    tool_alias: z.string().min(1, 'tool_alias must not be empty').optional(),
    pinned_version_number: z.number().int().min(1, 'pinned_version_number must be at least 1').optional(),
    off: z.literal(true).optional(),
  })
  .refine(
    (b) => [b.tool_alias, b.pinned_version_number, b.off].filter((v) => v !== undefined).length === 1,
    { message: 'Provide exactly one of tool_alias, pinned_version_number, or off.' },
  );

/** DTO for setting one binding. */
export type SetBindingDto = z.infer<typeof SetBindingBodySchema>;

/**
 * One binding as the API reports it. `toolAlias` and `pinnedVersionNumber` are
 * mutually exclusive, and both null means the binding is off.
 */
export interface BindingDetail {
  /** UUID of the bound tool. */
  toolId: string;
  /** The tool's current catalog name, for display. */
  toolName: string;
  /** Tool alias this binding follows, or null when pinned or off. */
  toolAlias: string | null;
  /** Pinned tool version number, or null when following an alias or off. */
  pinnedVersionNumber: number | null;
  /** True when both of the above are null — the tool is deliberately excluded. */
  off: boolean;
  /**
   * Tool version this binding resolves to right now, so a caller can show what
   * will actually run without a second request. Null when off, or when the
   * followed tool alias has since disappeared.
   */
  resolvedVersionNumber: number | null;
  /** Stable ordering within this alias's list. */
  position: number;
}

/** One prompt alias and the bindings it owns, if any. */
export interface AliasBindings {
  /** The prompt alias name (e.g. 'production'). */
  alias: string;
  /** Prompt version this alias currently serves — the template, not the tools. */
  versionNumber: number;
  /**
   * False when this alias has no rows of its own and therefore simply inherits
   * `default`. The dashboard shows a column only for customised aliases.
   */
  customised: boolean;
  /** Only this alias's own rows — not the inherited default. */
  bindings: BindingDetail[];
}

/** Full binding picture for one prompt: the default plus every alias. */
export interface PromptBindings {
  /** Bindings every alias inherits unless it has a row of its own. */
  default: BindingDetail[];
  /** Every prompt alias that exists today, customised or not. */
  aliases: AliasBindings[];
}
