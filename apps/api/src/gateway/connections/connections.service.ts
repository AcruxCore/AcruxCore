import { ConnectionsRepository } from './connections.repository';
import { encryptSecret } from './crypto';
import {
  CreateConnectionDto,
  UpdateConnectionDto,
  ProviderConnectionDto,
} from './connections.types';
import { ProviderConnection } from '../../shared/db/schema';
import { audit } from '../../shared/audit';
import prisma from '../../shared/db/client';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { Prisma } from '@prisma/client';

/**
 * Business logic for provider connections: encrypts secrets on write, masks them
 * on read, enforces team isolation, and emits audit events for create/delete.
 */
export class ConnectionsService {
  constructor(private readonly repo: ConnectionsRepository) {}

  /**
   * Encrypts the provider key, stores the connection, and emits
   * `provider_connection_created`.
   *
   * @param teamId - The team the connection belongs to.
   * @param actorId - The user creating it (written to createdBy + audit).
   * @param dto - Validated create payload (provider, label, apiKey, config).
   * @returns The masked connection (no plaintext key, no ciphertext).
   */
  async create(
    teamId: string,
    actorId: string,
    dto: CreateConnectionDto,
  ): Promise<ProviderConnectionDto> {
    const row = await this.repo.create({
      teamId,
      provider: dto.provider,
      label: dto.label,
      secretCiphertext: encryptSecret(dto.apiKey),
      keyLastFour: dto.apiKey.slice(-4),
      config: dto.config as Prisma.InputJsonValue,
      createdBy: actorId,
    });

    await audit(prisma, {
      teamId,
      actorId,
      event: 'provider_connection_created',
      metadata: { connectionId: row.id, provider: row.provider, label: row.label },
    });

    return this.toDto(row);
  }

  /**
   * Lists the team's connections, masked.
   *
   * @param teamId - The current team's UUID.
   */
  async list(teamId: string): Promise<ProviderConnectionDto[]> {
    const rows = await this.repo.listByTeam(teamId);
    return rows.map((row) => this.toDto(row));
  }

  /**
   * Fetches one masked connection scoped to the team.
   *
   * @param id - Connection UUID.
   * @param teamId - Isolation boundary.
   * @throws {NotFoundError} If the connection does not exist or is in another team.
   */
  async get(id: string, teamId: string): Promise<ProviderConnectionDto> {
    const row = await this.repo.findByIdForTeam(id, teamId);
    if (!row) throw new NotFoundError('Provider connection not found.');
    return this.toDto(row);
  }

  /**
   * Updates label/config and/or rotates the key (re-encrypting and refreshing
   * `keyLastFour` when a new `apiKey` is supplied), and emits
   * `provider_connection_updated` — `metadata.rotatedKey` distinguishes a key
   * rotation from a label/config-only update rather than using a second enum value.
   *
   * @param id - Connection UUID.
   * @param teamId - Isolation boundary (verified before mutating).
   * @param actorId - The user performing the update (for audit).
   * @param dto - Validated partial update.
   * @returns The updated masked connection.
   * @throws {NotFoundError} If the connection does not exist or is in another team.
   */
  async update(
    id: string,
    teamId: string,
    actorId: string,
    dto: UpdateConnectionDto,
  ): Promise<ProviderConnectionDto> {
    const existing = await this.repo.findByIdForTeam(id, teamId);
    if (!existing) throw new NotFoundError('Provider connection not found.');

    const patch: {
      label?: string;
      secretCiphertext?: Buffer;
      keyLastFour?: string;
      config?: Prisma.InputJsonValue;
    } = {};
    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.config !== undefined) patch.config = dto.config as Prisma.InputJsonValue;
    const rotatedKey = dto.apiKey !== undefined;
    if (rotatedKey) {
      patch.secretCiphertext = encryptSecret(dto.apiKey!);
      patch.keyLastFour = dto.apiKey!.slice(-4);
    }

    const row = await this.repo.update(id, patch);

    await audit(prisma, {
      teamId,
      actorId,
      event: 'provider_connection_updated',
      metadata: { connectionId: id, rotatedKey },
    });

    return this.toDto(row);
  }

  /**
   * Deletes a connection (hard delete) and emits `provider_connection_deleted`.
   *
   * @param id - Connection UUID.
   * @param teamId - Isolation boundary (verified before deleting).
   * @param actorId - The user performing the delete (for audit).
   * @throws {NotFoundError} If the connection does not exist or is in another team.
   * @throws {ConflictError} 409 CREDENTIAL_IN_USE if a registered model still binds this credential
   *   (the FK is `onDelete: Restrict`).
   */
  async delete(id: string, teamId: string, actorId: string): Promise<void> {
    const existing = await this.repo.findByIdForTeam(id, teamId);
    if (!existing) throw new NotFoundError('Provider connection not found.');

    try {
      await this.repo.delete(id);
    } catch (err) {
      // Prisma throws P2003 (FK constraint) when a gateway_models row still references it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictError(
          'CREDENTIAL_IN_USE',
          'This credential is used by one or more registered models. Delete or reassign them first.',
        );
      }
      throw err;
    }

    await audit(prisma, {
      teamId,
      actorId,
      event: 'provider_connection_deleted',
      metadata: { connectionId: id, provider: existing.provider },
    });
  }

  /**
   * Maps a DB row to the masked DTO — strips `secretCiphertext`, exposes only
   * `keyLastFour`.
   *
   * @param row - The Prisma `ProviderConnection` row.
   */
  private toDto(row: ProviderConnection): ProviderConnectionDto {
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      keyLastFour: row.keyLastFour,
      config: row.config as Record<string, unknown>,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
