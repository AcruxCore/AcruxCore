import { VersionsRepository } from './versions.repository';
import { extractVariables, NunjucksParseError } from './nunjucks.utils';
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  CreateVersionDto,
  PreparedVersion,
  VersionDetail,
  VersionListItem,
  VersionByIdResponse,
} from './versions.types';
import type { AliasDetail } from '../aliases/aliases.types';
import { AliasesRepository } from '../aliases/aliases.repository';
import { PromptToolResolver } from './prompt-tool-resolver';
import { ToolsRepository } from '../../tools/tools.repository';
import { ToolAliasesRepository } from '../../tools/aliases/aliases.repository';
import { ToolVersionsRepository } from '../../tools/versions/versions.repository';
import { ModelsRepository } from '../../gateway/models/models.repository';
import { PromptsRepository } from '../prompts.repository';
import { audit } from '../../shared/audit/audit.helper';
import prisma from '../../shared/db/client';
import { NotFoundError, ValidationError } from '../../shared/errors/http-errors';
import { AppError } from '../../shared/errors/app-error';
import type { TemplateContent } from './nunjucks.utils';

/**
 * Business logic for prompt versioning.
 * Orchestrates: parse → extract variables → insert version → auto-create aliases on v1 → audit.
 */
export class VersionsService {
  private versionsRepo: VersionsRepository;
  private aliasesRepo: AliasesRepository;
  private toolsRepo: ToolsRepository;
  private toolAliasesRepo: ToolAliasesRepository;
  private toolVersionsRepo: ToolVersionsRepository;
  private modelsRepo: ModelsRepository;
  private promptsRepo: PromptsRepository;
  private readonly toolResolver = new PromptToolResolver();

  constructor() {
    this.versionsRepo = new VersionsRepository();
    this.aliasesRepo = new AliasesRepository();
    this.toolsRepo = new ToolsRepository();
    this.toolAliasesRepo = new ToolAliasesRepository();
    this.toolVersionsRepo = new ToolVersionsRepository();
    this.modelsRepo = new ModelsRepository();
    this.promptsRepo = new PromptsRepository();
  }

  /**
   * Verifies a prompt exists and belongs to the team, throwing NotFoundError if not.
   * Used before any version mutation to avoid operating on inaccessible prompts.
   *
   * @param promptId - UUID of the prompt to verify.
   * @param teamId - UUID of the authenticated user's team.
   * @throws {NotFoundError} If the prompt is not found, belongs to another team, or is deleted.
   */
  private async assertPromptAccessible(promptId: string, teamId: string): Promise<void> {
    const prompt = await this.promptsRepo.findById(promptId, teamId);
    if (!prompt) {
      throw new NotFoundError('Prompt not found');
    }
  }

  /**
   * Commits a new immutable version for a prompt.
   *
   * A version decides the template only. Which tools the prompt calls lives in
   * `prompt_tool_bindings`, keyed by the prompt's own alias rather than by a
   * version (phase-4-faq Q53), so committing says nothing about tools and the
   * request body no longer carries a `tools` field.
   *
   * Steps:
   * 1. Verifies prompt exists in team.
   * 2. Parses each message content as nunjucks — 400 on syntax error.
   * 3. Extracts variable names from AST.
   * 4. Resolves + validates the optional default model, before any write, so a
   *    400 here never leaves behind a persisted (phantom) version row.
   * 5. Computes next version_number (MAX + 1 per prompt).
   * 6. Inserts prompt_versions row.
   * 7. If version_number === 1, auto-creates 'production' and 'staging' aliases.
   * 8. Emits audit event 'version_committed'.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the authenticated user (stored as createdBy).
   * @param dto - Validated request body containing the messages array.
   * @returns The created version, plus `aliases` if this was the first version.
   * @throws {NotFoundError} If the prompt doesn't exist or belongs to another team.
   * @throws {AppError} With code 'TEMPLATE_PARSE_ERROR' if any message content is invalid nunjucks.
   * @throws {ValidationError} If `model` is not registered for this team.
   */
  async commitVersion(
    promptId: string,
    teamId: string,
    userId: string,
    dto: CreateVersionDto,
  ): Promise<{ version: VersionDetail; aliases?: AliasDetail[] }> {
    return this.insertVersion(await this.prepareVersion(promptId, teamId, dto), teamId, userId);
  }

  /**
   * Steps 1–4 of {@link commitVersion}: every check a commit makes, with no
   * write. Split out so a caller that must insert while holding a lock (the
   * optimizer's candidate commit) can run these reads before taking it.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param dto - The messages and optional default model to commit.
   * @returns The checked version, ready for {@link insertVersion}.
   * @throws {NotFoundError} If the prompt doesn't exist or belongs to another team.
   * @throws {AppError} With code 'TEMPLATE_PARSE_ERROR' if any message content is invalid nunjucks.
   * @throws {ValidationError} If `model` is not registered for this team.
   */
  async prepareVersion(promptId: string, teamId: string, dto: CreateVersionDto): Promise<PreparedVersion> {
    await this.assertPromptAccessible(promptId, teamId);

    // Parse all messages upfront — fail fast on the first syntax error
    let variables: string[];
    try {
      variables = extractVariables(dto.messages);
    } catch (err) {
      if (err instanceof NunjucksParseError) {
        throw new AppError(err.message, 400, 'TEMPLATE_PARSE_ERROR');
      }
      throw err;
    }

    // #12: resolve the optional default model publicName → id, team-scoped, so a
    // bad model 400s before any version row is written — fail fast, so a validation
    // failure never leaves a phantom (persisted but "failed") version behind.
    let modelId: string | null = null;
    if (dto.model) {
      const gm = await this.modelsRepo.findByPublicName(teamId, dto.model);
      if (!gm) {
        throw new ValidationError(`Model '${dto.model}' is not registered for this team.`);
      }
      modelId = gm.id;
    }

    return { promptId, messages: dto.messages, variables, modelId, model: dto.model ?? null };
  }

  /**
   * Steps 5–8 of {@link commitVersion}: numbers and inserts a prepared
   * version, creates the first version's aliases, and records the audit event.
   *
   * With `tx`, every write runs on that transaction's connection and the audit
   * row is awaited inside it, so a rollback leaves no version and no audit row,
   * and the caller never needs a second pooled connection while it holds a lock.
   *
   * @param prepared - The output of {@link prepareVersion}.
   * @param teamId - UUID of the authenticated user's team.
   * @param userId - UUID of the authenticated user (stored as createdBy).
   * @param tx - The caller's transaction, or none for a transaction of its own.
   * @returns The created version, plus `aliases` if this was the first version.
   */
  async insertVersion(
    prepared: PreparedVersion,
    teamId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ version: VersionDetail; aliases?: AliasDetail[] }> {
    const { promptId } = prepared;
    const row = await this.versionsRepo.createNext(
      {
        promptId,
        messages: prepared.messages,
        variables: prepared.variables,
        createdBy: userId,
        modelId: prepared.modelId,
      },
      tx,
    );

    const version: VersionDetail = {
      id: row.id,
      promptId: row.promptId,
      versionNumber: row.versionNumber,
      messages: row.messages as Array<{ role: string; content: TemplateContent }>,
      variables: row.variables as string[],
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      model: prepared.model,
    };

    // Auto-create production + staging aliases on first version
    let aliases: AliasDetail[] | undefined;
    if (row.versionNumber === 1) {
      aliases = await this.aliasesRepo.autoCreateAliases(promptId, row.id, tx);
    }

    const event = {
      teamId,
      actorId: userId,
      event: 'version_committed' as const,
      promptId,
      metadata: { versionNumber: row.versionNumber },
    };
    // audit() takes a PrismaClient; a transaction client has the auditLog delegate it uses.
    if (tx) await audit(tx as PrismaClient, event);
    else void audit(prisma, event);

    return { version, aliases };
  }


  /**
   * Lists versions for a prompt, newest first, without message content.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param page - 1-based page number.
   * @param limit - Items per page (max 100).
   * @returns Paginated list of version summaries and total count.
   * @throws {NotFoundError} If the prompt doesn't exist or belongs to another team.
   */
  async listVersions(
    promptId: string,
    teamId: string,
    page: number,
    limit: number,
  ): Promise<{ data: VersionListItem[]; total: number; page: number; limit: number }> {
    await this.assertPromptAccessible(promptId, teamId);

    const { rows, total } = await this.versionsRepo.listByPrompt(promptId, page, limit);

    return {
      data: rows.map((r) => ({
        id: r.id,
        versionNumber: r.versionNumber,
        variables: r.variables as string[],
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        model: r.model?.publicName ?? null,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Fetches a specific version by its sequential number, including full message content.
   *
   * @param promptId - UUID of the prompt.
   * @param teamId - UUID of the authenticated user's team.
   * @param versionNumber - The 1-based sequential version number.
   * @returns Full version detail including messages.
   * @throws {NotFoundError} If the prompt or version is not found.
   */
  async getVersion(
    promptId: string,
    teamId: string,
    versionNumber: number,
  ): Promise<VersionDetail> {
    await this.assertPromptAccessible(promptId, teamId);

    const row = await this.versionsRepo.findByVersionNumber(promptId, versionNumber);
    if (!row) {
      throw new NotFoundError(`Version ${versionNumber} not found for this prompt`);
    }

    return {
      id: row.id,
      promptId: row.promptId,
      versionNumber: row.versionNumber,
      messages: row.messages as Array<{ role: string; content: TemplateContent }>,
      variables: row.variables as string[],
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      model: row.model?.publicName ?? null,
    };
  }

  /**
   * Resolves a version by its UUID to the data needed to prefill the Playground:
   * the parent prompt id/name, the version number, and the raw template messages.
   *
   * @param versionId - UUID of the prompt_versions row.
   * @param teamId - UUID of the authenticated user's team (isolation boundary).
   * @returns The prompt + version summary with raw messages and resolved tools.
   * @throws {NotFoundError} If the version is missing or belongs to another team.
   */
  async getVersionById(versionId: string, teamId: string): Promise<VersionByIdResponse> {
    const row = await this.versionsRepo.findByIdWithPromptForTeam(versionId, teamId);
    if (!row) {
      throw new NotFoundError('Prompt version not found');
    }
    const tools = await this.toolResolver.resolveDefault(row.prompt.id);
    return {
      promptId: row.prompt.id,
      promptName: row.prompt.name,
      versionNumber: row.versionNumber,
      messages: row.messages as Array<{ role: string; content: TemplateContent }>,
      variables: row.variables as string[],
      tools,
      model: row.model?.publicName ?? null,
    };
  }
}
