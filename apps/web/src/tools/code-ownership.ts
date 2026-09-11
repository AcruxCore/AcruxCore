import type { ToolVersionSource } from '@/api';

/**
 * Which banner the New-version dialog shows above the form.
 *
 * - `none` — nothing code-owned is live, so the edit is unremarkable.
 * - `deploy-supersedes` — the live version came from code *and* carries a
 *   description, so the next `tools.sync` commits over this edit and moves
 *   `production` off it.
 * - `description-is-yours` — the live version came from code but has no
 *   description, so the next sync carries this text forward instead.
 */
export type CodeOwnedBanner = 'none' | 'deploy-supersedes' | 'description-is-yours';

/**
 * Decide which warning a code-owned tool deserves before someone edits it here.
 *
 * A decorated function's description comes from its docstring, and a function with
 * no docstring sends no description at all. The API resolves that as
 * `dto.description ?? currentVersion.description` (`tools/sync/sync.service.ts`), so
 * a docstring-less definition can only ever carry the live description forward — it
 * cannot overwrite it, and with nothing else changed it commits no version at all.
 * Warning that a deploy will supersede the edit is therefore wrong for exactly the
 * tools whose wording the dashboard is meant to own.
 *
 * @param liveVersionSource - `source` of the version `production` points at, or null
 *   when no `production` alias is set.
 * @param liveVersionDescription - That version's description. Blank or absent means
 *   the code supplied none, which is what makes the edit permanent.
 * @returns The banner to render; `none` when the live version is not code-owned.
 */
export function codeOwnedBanner(
  liveVersionSource: ToolVersionSource | null | undefined,
  liveVersionDescription: string | null | undefined,
): CodeOwnedBanner {
  if (liveVersionSource !== 'code') return 'none';
  return liveVersionDescription?.trim() ? 'deploy-supersedes' : 'description-is-yours';
}
