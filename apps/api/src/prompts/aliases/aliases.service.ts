import { AliasesRepository } from './aliases.repository';
import { VersionsRepository } from '../versions/versions.repository';
import { PromptsRepository } from '../prompts.repository';
import { renderMessages, NunjucksRenderError } from '../versions/nunjucks.utils';
import { PromptToolResolver } from '../versions/prompt-tool-resolver';
import type { AliasDetail, RenderResponse, RenderedWithVersion, PromoteAliasDto } from './aliases.types';
import { audit } from '../../shared/audit/audit.helper';
import prisma from '../../shared/db/client';
import { NotFoundError } from '../../shared/errors/http-errors';
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
  ): Promise<RenderResponse> {
    const { messages, tools, model, versionId, versionNumber } = await this.resolveAndRender(
      teamId,
      promptName,
      alias,
      variables,
    );
    return { messages, tools, model, versionId, versionNumber };
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
   * @returns Rendered messages plus the resolved versionId, versionNumber, and tools.
   * @throws {NotFoundError} If prompt or alias not found.
   * @throws {AppError} With code 'MISSING_VARIABLES' (400) if required vars are absent.
   * @throws {AppError} With code 'TEMPLATE_RENDER_ERROR' (422) on a nunjucks runtime error.
   */
  async resolveAndRender(
    teamId: string,
    promptName: string,
    alias: string,
    variables: Record<string, unknown>,
  ): Promise<RenderedWithVersion> {
    const resolved = await this.aliasesRepo.findByPromptName(teamId, promptName, alias);
    if (!resolved) {
      throw new NotFoundError('Prompt or alias not found');
    }

    // Validate required variables are present
    const missing = resolved.variables.filter((v) => !(v in variables));
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
        resolved.messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        variables,
      );
      const tools = await this.toolResolver.resolveForVersion(resolved.versionId);
      return {
        messages,
        versionId: resolved.versionId,
        versionNumber: resolved.versionNumber,
        tools,
        model: resolved.model,
      };
    } catch (err) {
      if (err instanceof NunjucksRenderError) {
        throw new AppError(err.message, 422, 'TEMPLATE_RENDER_ERROR');
      }
      throw err;
    }
  }
}
