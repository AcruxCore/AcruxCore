import { ToolVersionsRepository } from './versions.repository';
import { ToolAliasesRepository } from '../aliases/aliases.repository';
import { ToolsRepository } from '../tools.repository';
import { AliasDetail } from '../aliases/aliases.types';
import { CreateToolVersionDto, Executor, ToolVersionDetail, ToolVersionListItem } from './versions.types';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';
import { SecretsRepository } from '../../secrets/secrets.repository';
import { compileTransform, TransformError } from '../execute/js-transform';
import { extractSecretRefs } from '../execute/secret-refs';
import { assertPublicUrl, SsrfError } from '../execute/safe-fetch';

/**
 * Business logic for committing/reading immutable tool versions.
 * Orchestrates: verify tool accessible → deep-validate an http executor's JS
 * transforms + secret refs → insert version → auto-create aliases on v1 → audit.
 */
export class ToolVersionsService {
  private readonly versionsRepo = new ToolVersionsRepository();
  private readonly aliasesRepo = new ToolAliasesRepository();
  private readonly toolsRepo = new ToolsRepository();
  private readonly secretsRepo = new SecretsRepository();

  /**
   * Deep-validates an `http` executor beyond Zod's shape check.
   *
   * Public because `POST /tools/sync` must apply exactly the same commit-time
   * validation as `POST /tools/:id/versions` — a second copy would drift, and the
   * cheaper half of the check (transform compilation, secret existence) is the half a
   * code-authored executor is most likely to get wrong.
   *
   * Specifically: any
   * `requestTransform`/`responseTransform` must compile (FAQ Q10), every
   * `{{secret.NAME}}` reference in headers/query must resolve to a secret that
   * exists for the team (FAQ Q11), and `url` must pass the SSRF guard
   * (`assertPublicUrl`). A `client` executor has nothing to check here.
   *
   * The SSRF check runs last (after the cheaper, no-network transform/secret
   * checks) and is deliberately **defense-in-depth, not a replacement** for the
   * execute-time `safeFetch` guard in `execute.service.ts`: a hostname's DNS
   * answer can legitimately change between commit time and execute time, so
   * this only catches obviously-bad URLs earlier — it never removes the need
   * for the execute-time, DNS-pinned check.
   *
   * @param executor - The validated (shape-only) executor from the request body.
   * @param teamId - UUID of the authenticated user's team, to scope the secret lookup.
   * @throws {ValidationError} If a transform fails to compile, a referenced secret
   *   doesn't exist, or `url` resolves to a private/loopback/link-local/metadata address.
   */
  async assertExecutorDeepValid(executor: Executor, teamId: string): Promise<void> {
    if (executor.type !== 'http') return;

    if (executor.requestTransform) {
      try {
        compileTransform(executor.requestTransform);
      } catch (err) {
        throw new ValidationError(err instanceof TransformError ? err.message : 'Invalid requestTransform.');
      }
    }
    if (executor.responseTransform) {
      try {
        compileTransform(executor.responseTransform);
      } catch (err) {
        throw new ValidationError(err instanceof TransformError ? err.message : 'Invalid responseTransform.');
      }
    }

    const refNames = extractSecretRefs(executor);
    for (const name of refNames) {
      const secret = await this.secretsRepo.findByNameForTeam(name, teamId);
      if (!secret) throw new ValidationError(`Referenced secret '${name}' does not exist.`);
    }

    try {
      await assertPublicUrl(executor.url);
    } catch (err) {
      if (err instanceof SsrfError) throw new ValidationError(err.message);
      throw err;
    }
  }

  /**
   * Verifies a tool exists and belongs to the team, throwing NotFoundError if not.
   * Used before any version mutation or read to avoid operating on inaccessible tools.
   *
   * @param toolId - UUID of the tool to verify.
   * @param teamId - UUID of the authenticated user's team.
   * @throws {NotFoundError} If the tool is not found, belongs to another team, or is deleted.
   */
  private async assertToolAccessible(toolId: string, teamId: string): Promise<void> {
    const tool = await this.toolsRepo.findById(toolId, teamId);
    if (!tool) throw new NotFoundError('Tool not found.');
  }

  /**
   * Commits a new immutable version for a tool.
   *
   * Steps:
   * 1. Verifies tool exists in team.
   * 2. For an `http` executor, deep-validates JS transform syntax + secret refs + SSRF guard.
   * 3. Computes next version_number (MAX + 1 per tool).
   * 4. Inserts tool_versions row.
   * 5. If version_number === 1, auto-creates 'production' and 'staging' aliases.
   * 6. Emits audit event 'tool_version_committed'.
   *
   * @param toolId - UUID of the tool.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the authenticated user (stored as createdBy).
   * @param dto - Validated request body containing parametersSchema + executor.
   * @returns The created version, plus `aliases` if this was the first version, plus
   *   `warnings` when the committed combination of fields is legal but probably not
   *   what the author meant (see below).
   * @throws {NotFoundError} If the tool doesn't exist or belongs to another team.
   * @throws {ValidationError} If an http executor's transform fails to compile,
   *   references a secret that doesn't exist for the team, or its `url` resolves to a
   *   private/loopback/link-local/metadata address (defense-in-depth; the execute-time
   *   guard in `execute.service.ts` remains the binding check).
   */
  async commitVersion(
    toolId: string,
    teamId: string,
    userId: string,
    dto: CreateToolVersionDto,
  ): Promise<{ version: ToolVersionDetail; aliases?: AliasDetail[]; warnings?: string[] }> {
    await this.assertToolAccessible(toolId, teamId);
    await this.assertExecutorDeepValid(dto.executor, teamId);

    const versionNumber = await this.versionsRepo.computeNextVersionNumber(toolId);
    const row = await this.versionsRepo.create({
      toolId,
      versionNumber,
      description: dto.description,
      changelog: dto.changelog,
      source: dto.source,
      parametersSchema: dto.parametersSchema,
      executor: dto.executor,
      createdBy: userId,
    });

    const version: ToolVersionDetail = {
      id: row.id,
      toolId: row.toolId,
      versionNumber: row.versionNumber,
      description: row.description,
      changelog: row.changelog,
      source: row.source,
      parametersSchema: row.parametersSchema,
      executor: row.executor as unknown as Executor,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };

    let aliases: AliasDetail[] | undefined;
    if (versionNumber === 1) {
      aliases = await this.aliasesRepo.autoCreateAliases(toolId, row.id);
    }

    void audit(prisma, {
      teamId,
      actorId: userId,
      event: 'tool_version_committed',
      metadata: { toolId, versionNumber },
    });

    // The resolver reads `version.description ?? tool.description`. A version with a
    // changelog and no description therefore serves the TOOL-level description to the
    // model — rarely what someone writing release notes intended, and the exact
    // confusion `changelog` was added to end. Say so rather than 201-ing quietly.
    const warnings: string[] = [];
    if (dto.changelog && !dto.description) {
      warnings.push(
        'This version has a changelog but no description, so the model will read the tool-level description instead. `description` is what the model reads; `changelog` is a note for your team.',
      );
    }

    return { version, aliases, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  /**
   * Lists versions for a tool, newest first, without parametersSchema/executor.
   *
   * @param toolId - UUID of the tool.
   * @param teamId - UUID of the authenticated user's team.
   * @param page - 1-based page number.
   * @param limit - Items per page (max 100).
   * @returns Paginated list of version summaries and total count.
   * @throws {NotFoundError} If the tool doesn't exist or belongs to another team.
   */
  async listVersions(
    toolId: string,
    teamId: string,
    page: number,
    limit: number,
  ): Promise<{ data: ToolVersionListItem[]; total: number; page: number; limit: number }> {
    await this.assertToolAccessible(toolId, teamId);

    const { rows, total } = await this.versionsRepo.listByTool(toolId, page, limit);

    return {
      data: rows.map((r) => ({
        id: r.id,
        toolId: r.toolId,
        versionNumber: r.versionNumber,
        description: r.description,
        changelog: r.changelog,
        source: r.source,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Fetches a specific version by its sequential number, including full
   * parametersSchema + executor.
   *
   * @param toolId - UUID of the tool.
   * @param teamId - UUID of the authenticated user's team.
   * @param versionNumber - The 1-based sequential version number.
   * @returns Full version detail.
   * @throws {NotFoundError} If the tool or version is not found.
   */
  async getVersion(toolId: string, teamId: string, versionNumber: number): Promise<ToolVersionDetail> {
    await this.assertToolAccessible(toolId, teamId);

    const row = await this.versionsRepo.findByVersionNumber(toolId, versionNumber);
    if (!row) throw new NotFoundError(`Version ${versionNumber} not found for this tool.`);

    return {
      id: row.id,
      toolId: row.toolId,
      versionNumber: row.versionNumber,
      description: row.description,
      changelog: row.changelog,
      source: row.source,
      parametersSchema: row.parametersSchema,
      executor: row.executor as unknown as Executor,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
