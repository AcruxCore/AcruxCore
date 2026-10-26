import { AliasesRepository } from './aliases.repository';
import { VersionsRepository } from '../versions/versions.repository';
import { PromptsRepository } from '../prompts.repository';
import { renderMessages, extractVariables, NunjucksRenderError } from '../versions/nunjucks.utils';
import type { TemplateContent } from '../versions/nunjucks.utils';
import { PromptToolResolver } from '../versions/prompt-tool-resolver';
import { VersionsService } from '../versions/versions.service';
import type { VersionDetail } from '../versions/versions.types';
import type { AliasDetail, AliasWithVersion, RenderResponse, RenderedWithVersion, PromoteAliasDto } from './aliases.types';
import { audit } from '../../shared/audit/audit.helper';
import prisma from '../../shared/db/client';
import { NotFoundError, ValidationError } from '../../shared/errors/http-errors';
import { AppError } from '../../shared/errors/app-error';

/**
 * A resolved comparison baseline for an experiment/optimize run — either a
 * named alias's current version, or (when no alias was requested) the
 * prompt's `production` alias if one exists, or (only if there is no
 * `production` alias either) the prompt's most recently committed version.
 */
export interface BaselineVersion {
  versionId: string;
  versionNumber: number;
  /** The alias name used to resolve this, or null when resolved via "latest version". */
  alias: string | null;
}

/**
 * Business logic for alias management and prompt rendering.
 */
export class AliasesService {
  private aliasesRepo: AliasesRepository;
  private versionsRepo: VersionsRepository;
  private promptsRepo: PromptsRepository;
  private readonly toolResolver = new PromptToolResolver();
  private readonly versions = new VersionsService();

  constructor() {
    this.aliasesRepo = new AliasesRepository();
    this.versionsRepo = new VersionsRepository();
    this.promptsRepo = new PromptsRepository();
  }

  /**
   * Verifies a prompt exists and belongs to the team.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @throws {NotFoundError} If the prompt is not accessible.
   */
  private async assertPromptAccessible(promptId: string, teamId: string): Promise<void> {
    const prompt = await this.promptsRepo.findById(promptId, teamId);
    if (!prompt) throw new NotFoundError('Prompt not found');
  }

  /**
   * The version an alias points at, found by prompt name: its template, not rendered.
   *
   * One request for what an SDK otherwise does in three (search the prompt by name, list
   * its aliases, fetch the version). The alias row names an immutable version, so the
   * answer is one consistent version even if the alias moves while this runs.
   *
   * @param teamId - UUID of the authenticated user's team.
   * @param promptName - The prompt's exact name.
   * @param alias - The alias to resolve, e.g. `production`. With `version` it is
   *   still checked, but the version comes from the pin.
   * @param version - A version number to return instead of the alias's version, for an
   *   app testing a version that no alias points at yet (phase-5 FAQ Q58).
   * @returns The version, in the same shape as `GET /prompts/:id/versions/:n`.
   * @throws {NotFoundError} If the team has no prompt of that name, it has no such alias,
   *   or it has no such version.
   */
  async getVersionByAlias(
    teamId: string,
    promptName: string,
    alias: string | undefined,
    version?: number,
  ): Promise<VersionDetail> {
    if (alias === undefined) {
      // A pin with no alias named: only the prompt has to exist.
      if (version === undefined) throw new ValidationError('alias or version is required');
      const prompt = await this.promptsRepo.findByName(promptName, teamId);
      if (!prompt) throw new NotFoundError('Prompt not found');
      return this.versions.getVersion(prompt.id, teamId, version);
    }
    // A named alias must exist even under a pin, as it must for a pinned render;
    // otherwise a misspelled alias reads fine and then fails on render.
    const target = await this.aliasesRepo.findAliasTarget(teamId, promptName, alias);
    if (!target) throw new NotFoundError('Prompt or alias not found');
    return this.versions.getVersion(target.promptId, teamId, version ?? target.versionNumber);
  }

  /**
   * Lists all aliases for a prompt, joined with their target version number.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @returns Array of alias details.
   * @throws {NotFoundError} If the prompt is not found.
   */
  async listAliases(promptId: string, teamId: string): Promise<AliasDetail[]> {
    await this.assertPromptAccessible(promptId, teamId);
    return this.aliasesRepo.listByPrompt(promptId);
  }

  /**
   * Promotes (or rollbacks) an alias to point to a different version.
   * Rollback is identical to promotion — it is just a promote to an older version number.
   *
   * Steps:
   * 1. Verifies prompt exists in team.
   * 2. Verifies the target version_number exists for this prompt.
   * 3. Captures the current alias state (for audit fromVersionNumber).
   * 4. Upserts the alias row.
   * 5. Emits audit event 'alias_promoted'.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the acting user.
   * @param alias - The alias name to promote (e.g. 'production').
   * @param dto - Validated body containing version_number.
   * @returns The updated alias detail.
   * @throws {NotFoundError} If prompt or version not found.
   */
  async promoteAlias(
    promptId: string,
    teamId: string,
    userId: string,
    alias: string,
    dto: PromoteAliasDto,
  ): Promise<AliasDetail> {
    await this.assertPromptAccessible(promptId, teamId);

    const targetVersion = await this.versionsRepo.findByVersionNumber(
      promptId,
      dto.version_number,
    );
    if (!targetVersion) {
      throw new NotFoundError(`Version ${dto.version_number} not found for this prompt`);
    }

    // Capture current alias state for audit metadata
    const currentAlias = await this.aliasesRepo.findByAlias(promptId, alias);
    const fromVersionNumber = currentAlias?.versionNumber ?? null;

    const result = await this.aliasesRepo.upsertAlias(promptId, alias, targetVersion.id);

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'alias_promoted',
      promptId,
      metadata: {
        alias,
        fromVersionNumber,
        toVersionNumber: dto.version_number,
      },
    });

    return result;
  }

  /**
   * Deletes a custom alias. Refuses to delete `production` or `staging`.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the acting user.
   * @param alias - The alias name to delete.
   * @returns true if deleted.
   * @throws {AppError} 400 if alias is production or staging.
   * @throws {NotFoundError} If the prompt is not found.
   */
  async deleteAlias(
    promptId: string,
    teamId: string,
    userId: string,
    alias: string,
  ): Promise<boolean> {
    await this.assertPromptAccessible(promptId, teamId);

    if (alias === 'production' || alias === 'staging') {
      throw new AppError(
        `Cannot delete the "${alias}" alias`,
        400,
        'CANNOT_DELETE_DEFAULT_ALIAS',
      );
    }

    const deleted = await this.aliasesRepo.deleteAlias(promptId, alias);
    if (!deleted) {
      throw new NotFoundError(`Alias "${alias}" not found`);
    }

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'alias_deleted',
      promptId,
      metadata: { alias },
    });

    return true;
  }

  /**
   * Resolves the comparison baseline for an experiment/optimize run (design
   * "Alias-based baseline"). Resolution order: a named alias's current
   * version when `alias` is given; otherwise the prompt's `production` alias
   * if one exists; otherwise the prompt's latest committed version. The
   * `production` fallback exists because a plain "latest version" default
   * silently drops the baseline cell whenever the version under test is
   * itself the latest committed version — the single most common flow — so
   * a run would come back with no regression comparison and no explanation.
   * Does NOT attempt to match against any trace/feedback lineage.
   *
   * @param teamId - Isolation boundary (used only for the "latest" path;
   *   `findByAlias` itself is not team-scoped, matching its existing callers).
   * @param promptId - UUID of the prompt.
   * @param alias - Alias name to resolve, or omitted for the production/latest default.
   * @returns The resolved baseline, or null if no alias was requested AND the
   *   prompt has neither a `production` alias nor any committed versions yet
   *   (mirrors the old silent-no-baseline behavior for a not-yet-set-up prompt).
   * @throws {NotFoundError} If `alias` was given but does not exist for this prompt.
   */
  async resolveBaselineVersion(teamId: string, promptId: string, alias?: string): Promise<BaselineVersion | null> {
    if (alias) {
      const found = await this.aliasesRepo.findByAlias(promptId, alias);
      if (!found) throw new NotFoundError(`Alias "${alias}" not found for this prompt`);
      return { versionId: found.versionId, versionNumber: found.versionNumber, alias };
    }
    const production = await this.aliasesRepo.findByAlias(promptId, 'production');
    if (production) {
      return { versionId: production.versionId, versionNumber: production.versionNumber, alias: 'production' };
    }
    const latest = await this.versionsRepo.findLatestForPrompt(promptId, teamId);
    return latest ? { versionId: latest.id, versionNumber: latest.versionNumber, alias: null } : null;
  }

  /**
   * The variable names a version's templates actually require.
   *
   * Derived from `messages` so that a correction to the extractor applies to every
   * prompt already stored, rather than only to versions committed afterwards. Falls
   * back to the list persisted at commit time when the templates no longer parse, so
   * an unparseable version reports its real error from the render step instead of here.
   *
   * @param resolved - The resolved version row, carrying both `messages` and the
   *   `variables` list persisted when it was committed.
   * @returns The required variable names.
   */
  private requiredVariables(resolved: { messages: unknown; variables: string[] }): string[] {
    try {
      return extractVariables(resolved.messages as Array<{ content: TemplateContent }>);
    } catch {
      return resolved.variables;
    }
  }

  /**
   * Resolves an alias to a version and renders the nunjucks template.
   * Lookup is by prompt name (mutable) + alias, not by prompt ID.
   *
   * Steps:
   * 1. Finds prompt by name in team; 404 if not found.
   * 2. Finds alias, joins to version content; 404 if alias not found.
   * 3. Validates all required template variables are provided; 400 if missing.
   * 4. Renders each message's content via nunjucks; 422 on runtime error.
   * 5. Returns OpenAI-compatible messages array plus the version's attached tools (FAQ Q4).
   *
   * @param teamId - UUID of the authenticated user's team.
   * @param promptName - Mutable display name of the prompt.
   * @param alias - Alias name (e.g. 'production').
   * @param variables - Key-value map of template variable values.
   * @param version - Optional version number whose template to render instead of the
   *   alias's; the alias still decides the tools (see {@link resolveAndRender}).
   * @returns Rendered messages, OpenAI-shaped tools, the version's bound default
   *   `model` (or null) — ready for LLM consumption without hardcoding a model — and
   *   the `versionId`/`versionNumber` that produced them, so a caller can link a trace
   *   back to the exact prompt version.
   * @throws {NotFoundError} If prompt or alias not found.
   * @throws {AppError} With code 'MISSING_VARIABLES' (400) if required vars are absent.
   * @throws {AppError} With code 'TEMPLATE_RENDER_ERROR' (422) on nunjucks runtime error.
   */
  async render(
    teamId: string,
    promptName: string,
    alias: string,
    variables: Record<string, unknown>,
    version?: number,
  ): Promise<RenderResponse> {
    const { messages, tools, toolResolutions, model, versionId, versionNumber } = await this.resolveAndRender(
      teamId,
      promptName,
      alias,
      variables,
      version,
    );
    return { messages, tools, toolResolutions, model, versionId, versionNumber };
  }

  /**
   * Resolves an alias to a version, validates required variables, renders the
   * nunjucks templates, and returns the rendered messages **plus** the resolved
   * version's id and number (lineage) and its attached tools (FAQ Q4). This is the
   * reusable core shared by the public render endpoint and the gateway's
   * prompt-reference pipeline (G8).
   *
   * @param teamId - UUID of the authenticated user's team.
   * @param promptName - Mutable display name of the prompt.
   * @param alias - Alias name (e.g. 'production').
   * @param variables - Key-value map of template variable values.
   * @param version - Optional version number to render instead of the alias's version
   *   (phase-5 FAQ Q58). Only the template changes: tools still come from the alias,
   *   because tool bindings are keyed by alias, not by version. So "production with
   *   version 7 pinned" is production exactly, with version 7's template — the thing a
   *   team wants to test before it moves production to version 7.
   * @returns Rendered messages plus the resolved versionId, versionNumber, and tools.
   * @throws {NotFoundError} If prompt or alias not found, or the pinned version does not exist.
   * @throws {AppError} With code 'MISSING_VARIABLES' (400) if required vars are absent.
   * @throws {AppError} With code 'TEMPLATE_RENDER_ERROR' (422) on a nunjucks runtime error.
   */
  async resolveAndRender(
    teamId: string,
    promptName: string,
    alias: string,
    variables: Record<string, unknown>,
    version?: number,
  ): Promise<RenderedWithVersion> {
    const resolved =
      version === undefined
        ? await this.aliasesRepo.findByPromptName(teamId, promptName, alias)
        : await this.pinnedVersion(teamId, promptName, alias, version);
    if (!resolved) {
      throw new NotFoundError('Prompt or alias not found');
    }

    // Validate required variables are present.
    //
    // Recomputed from the version's own messages, NOT read from the persisted
    // `prompt_versions.variables` column. The column was written by whichever
    // extractor was current when the version was committed, so a fix to the extractor
    // otherwise reaches no prompt that already exists — and worse, committing the next
    // version becomes the breaking step, because that is when the required list
    // suddenly grows and a caller passing the old set starts getting a 400.
    // Recomputing makes a fix apply everywhere at once, with no backfill to run and
    // no version to re-commit. `variables` is a pure function of `messages`, and the
    // parse is far cheaper than the render isolate that follows it.
    //
    // A version whose template no longer parses falls back to the stored list rather
    // than failing here; the render below then reports the real problem.
    const required = this.requiredVariables(resolved);
    const missing = required.filter((v) => !(v in variables));
    if (missing.length > 0) {
      throw new AppError(
        `Required variables are missing: ${missing.join(', ')}`,
        400,
        'MISSING_VARIABLES',
        { missing },
      );
    }

    // Render messages via nunjucks
    try {
      const messages = await renderMessages(
        resolved.messages as Array<{ role: 'system' | 'user' | 'assistant'; content: TemplateContent }>,
        variables,
      );
      const { tools, resolutions } = await this.toolResolver.resolveForAlias(resolved.promptId, alias);
      return {
        messages,
        versionId: resolved.versionId,
        versionNumber: resolved.versionNumber,
        tools,
        toolResolutions: resolutions,
        model: resolved.model,
      };
    } catch (err) {
      if (err instanceof NunjucksRenderError) {
        throw new AppError(err.message, 422, 'TEMPLATE_RENDER_ERROR');
      }
      throw err;
    }
  }

  /**
   * The alias's resolution with another version's template, model and lineage
   * in place of its own — the alias row itself (and so its tool bindings) is
   * kept. The alias's own template is never loaded. Null when the alias does
   * not exist.
   */
  private async pinnedVersion(
    teamId: string,
    promptName: string,
    alias: string,
    version: number,
  ): Promise<AliasWithVersion | null> {
    const target = await this.aliasesRepo.findAliasTarget(teamId, promptName, alias);
    if (!target) return null;
    const row = await this.versionsRepo.findByVersionNumber(target.promptId, version);
    if (!row) throw new NotFoundError(`Version ${version} not found for prompt "${promptName}"`);
    return {
      aliasId: target.aliasId,
      promptId: target.promptId,
      alias,
      versionId: row.id,
      versionNumber: row.versionNumber,
      messages: row.messages as Array<{ role: string; content: TemplateContent }>,
      variables: row.variables as string[],
      model: row.model?.publicName ?? null,
    };
  }
}
