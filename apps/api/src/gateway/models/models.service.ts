import { Prisma } from '@prisma/client';
import { ModelsRepository, GatewayModelWithRelations } from './models.repository';
import { ConnectionsRepository } from '../connections/connections.repository';
import { decryptSecret } from '../connections/crypto';
import { getAdapter, ProviderError } from '../providers/adapter';
import { lookupDefaultPricing } from '../providers/models';
import type { ProviderCredentials } from '../providers/types';
import { CreateModelDto, UpdateModelDto, GatewayModelDto, ModelTestResult } from './models.types';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors';

// Reads the base_url out of a credential's JSONB config (openai_compatible only).
function credentialBaseUrl(config: unknown): string | undefined {
  const c = (config ?? {}) as Record<string, unknown>;
  return typeof c['base_url'] === 'string' ? (c['base_url'] as string) : undefined;
}

/** Converts a nullable price number to a Prisma Decimal (or null). */
function toDecimal(n: number | null | undefined): Prisma.Decimal | null {
  return n == null ? null : new Prisma.Decimal(n);
}

/**
 * Business logic for the model registry: validates the bound credential and the
 * fallback chain, prefills pricing for known upstream models, emits audit events,
 * and runs the diagnostic Test call.
 */
export class ModelsService {
  constructor(
    private readonly repo: ModelsRepository,
    private readonly connectionsRepo: ConnectionsRepository = new ConnectionsRepository(),
  ) {}

  /**
   * Registers a model. Prices omitted from the payload are prefilled from the
   * static registry when the upstream model is known, else left null.
   *
   * @param teamId - The team the model belongs to.
   * @param actorId - The creating user (createdBy + audit).
   * @param dto - Validated create payload.
   * @returns The created model as a DTO.
   * @throws {ValidationError} If the credential is not in the team.
   * @throws {AppError} 400 INVALID_FALLBACK if any fallback id is unknown/self/duplicate.
   */
  async create(teamId: string, actorId: string, dto: CreateModelDto): Promise<GatewayModelDto> {
    await this.assertCredentialInTeam(dto.credentialId, teamId);
    await this.assertValidFallbacks(teamId, dto.fallbackModelIds, null);

    const { inputPricePerM, outputPricePerM } = this.resolvePrices(
      dto.upstreamModel,
      dto.inputPricePerM,
      dto.outputPricePerM,
    );

    const row = await this.repo.create({
      teamId,
      publicName: dto.publicName,
      upstreamModel: dto.upstreamModel,
      credentialId: dto.credentialId,
      inputPricePerM,
      outputPricePerM,
      createdBy: actorId,
      fallbackModelIds: this.dedupe(dto.fallbackModelIds),
    });

    await audit(prisma, {
      teamId,
      actorId,
      event: 'gateway_model_created',
      metadata: { modelId: row.id, publicName: row.publicName, upstreamModel: row.upstreamModel },
    });

    return this.toDto(row);
  }

  /**
   * Lists the team's models.
   * @param teamId - The current team's UUID.
   */
  async list(teamId: string): Promise<GatewayModelDto[]> {
    const rows = await this.repo.listByTeam(teamId);
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Gets one model scoped to the team.
   * @throws {NotFoundError} If missing or in another team.
   */
  async get(id: string, teamId: string): Promise<GatewayModelDto> {
    const row = await this.repo.findByIdForTeam(id, teamId);
    if (!row) throw new NotFoundError('Model not found.');
    return this.toDto(row);
  }

  /**
   * Updates a model. Omitted price fields are left unchanged (PATCH semantics);
   * an explicit null clears a price. Passing `fallbackModelIds` replaces the chain.
   *
   * @throws {NotFoundError} If missing or in another team.
   * @throws {ValidationError} If a new credential is not in the team.
   * @throws {AppError} 400 INVALID_FALLBACK on a bad fallback set.
   */
  async update(
    id: string,
    teamId: string,
    actorId: string,
    dto: UpdateModelDto,
  ): Promise<GatewayModelDto> {
    const existing = await this.repo.findByIdForTeam(id, teamId);
    if (!existing) throw new NotFoundError('Model not found.');

    if (dto.credentialId !== undefined) await this.assertCredentialInTeam(dto.credentialId, teamId);
    if (dto.fallbackModelIds !== undefined) {
      await this.assertValidFallbacks(teamId, dto.fallbackModelIds, id);
    }

    const patch: {
      publicName?: string;
      upstreamModel?: string;
      credentialId?: string;
      inputPricePerM?: Prisma.Decimal | null;
      outputPricePerM?: Prisma.Decimal | null;
    } = {};
    if (dto.publicName !== undefined) patch.publicName = dto.publicName;
    if (dto.upstreamModel !== undefined) patch.upstreamModel = dto.upstreamModel;
    if (dto.credentialId !== undefined) patch.credentialId = dto.credentialId;
    if (dto.inputPricePerM !== undefined) patch.inputPricePerM = toDecimal(dto.inputPricePerM);
    if (dto.outputPricePerM !== undefined) patch.outputPricePerM = toDecimal(dto.outputPricePerM);

    const fallbacks =
      dto.fallbackModelIds !== undefined ? this.dedupe(dto.fallbackModelIds) : undefined;

    const row = await this.repo.update(id, patch, fallbacks);

    await audit(prisma, {
      teamId,
      actorId,
      event: 'gateway_model_updated',
      metadata: { modelId: id, publicName: row.publicName },
    });

    return this.toDto(row);
  }

  /**
   * Deletes a model. Blocked (409) while it is another model's fallback.
   *
   * @throws {NotFoundError} If missing or in another team.
   * @throws {ConflictError} 409 MODEL_IS_FALLBACK if referenced by another model's chain.
   */
  async delete(id: string, teamId: string, actorId: string): Promise<void> {
    const existing = await this.repo.findByIdForTeam(id, teamId);
    if (!existing) throw new NotFoundError('Model not found.');

    if (await this.repo.isFallbackOfAny(id)) {
      throw new ConflictError('MODEL_IS_FALLBACK', 'This model is used as a fallback by another model.');
    }

    await this.repo.delete(id);

    await audit(prisma, {
      teamId,
      actorId,
      event: 'gateway_model_deleted',
      metadata: { modelId: id, publicName: existing.publicName },
    });
  }

  /**
   * Fires a minimal completion through the model's credential to verify it works.
   * No `max_tokens` cap is sent: reasoning models (o1/o3/o4-mini/gpt-5) spend
   * tokens on internal thinking before emitting output, so a tiny cap makes them
   * 400 with "max_tokens or model output limit was reached". Each provider
   * applies its own default, and the trivial "ping" prompt keeps the response
   * short on non-reasoning models. Never throws to the client; a provider failure
   * returns `ok:false`. Does not touch budgets or the usage log.
   *
   * @param id - Model UUID.
   * @param teamId - Isolation boundary.
   * @returns `{ ok, latencyMs }` on success or `{ ok:false, error }` on failure.
   * @throws {NotFoundError} If the model is missing or in another team.
   */
  async test(id: string, teamId: string): Promise<ModelTestResult> {
    const row = await this.repo.findByIdForTeam(id, teamId);
    if (!row) throw new NotFoundError('Model not found.');

    const adapter = getAdapter(row.credential.provider);
    const creds: ProviderCredentials = {
      apiKey: decryptSecret(row.credential.secretCiphertext),
      baseUrl: credentialBaseUrl(row.credential.config),
    };
    const startedAt = Date.now();
    try {
      await adapter.chatCompletion(
        { model: row.upstreamModel, messages: [{ role: 'user', content: 'ping' }] },
        creds,
      );
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      const message = err instanceof ProviderError || err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, error: message };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Prefills prices from the static registry only when a field was omitted (create path).
  private resolvePrices(
    upstreamModel: string,
    input: number | null | undefined,
    output: number | null | undefined,
  ): { inputPricePerM: Prisma.Decimal | null; outputPricePerM: Prisma.Decimal | null } {
    const defaults = lookupDefaultPricing(upstreamModel);
    const inN = input === undefined ? defaults?.inputPricePerM ?? null : input;
    const outN = output === undefined ? defaults?.outputPricePerM ?? null : output;
    return { inputPricePerM: toDecimal(inN), outputPricePerM: toDecimal(outN) };
  }

  private dedupe(ids: string[]): string[] {
    return [...new Set(ids)];
  }

  private async assertCredentialInTeam(credentialId: string, teamId: string): Promise<void> {
    const cred = await this.connectionsRepo.findByIdForTeam(credentialId, teamId);
    if (!cred) throw new ValidationError('credentialId does not reference a credential in this team.');
  }

  // Validates the fallback set: no self-reference, no duplicates that don't exist,
  // and every id belongs to a model in the team. `ownId` is the model being edited (excluded).
  private async assertValidFallbacks(
    teamId: string,
    ids: string[],
    ownId: string | null,
  ): Promise<void> {
    const unique = this.dedupe(ids);
    if (ownId && unique.includes(ownId)) {
      throw new AppError('A model cannot fall back to itself.', 400, 'INVALID_FALLBACK');
    }
    const existing = await this.repo.existingIdsInTeam(teamId, unique);
    const missing = unique.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      throw new AppError(
        `Unknown fallback model id(s): ${missing.join(', ')}.`,
        400,
        'INVALID_FALLBACK',
      );
    }
  }

  // Maps a DB row (with relations) to the read DTO.
  private toDto(row: GatewayModelWithRelations): GatewayModelDto {
    return {
      id: row.id,
      publicName: row.publicName,
      upstreamModel: row.upstreamModel,
      credentialId: row.credentialId,
      credentialLabel: row.credential.label,
      provider: row.credential.provider,
      inputPricePerM: row.inputPricePerM ? row.inputPricePerM.toNumber() : null,
      outputPricePerM: row.outputPricePerM ? row.outputPricePerM.toNumber() : null,
      fallbacks: row.fallbacks.map((f) => ({
        id: f.fallbackModel.id,
        publicName: f.fallbackModel.publicName,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
