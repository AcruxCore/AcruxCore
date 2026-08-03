import { SecretsRepository } from './secrets.repository';
import { CreateSecretDto, UpdateSecretDto, SecretDto } from './secrets.types';
import { encryptSecret } from '../gateway/connections/crypto';
import { audit } from '../shared/audit';
import { NotFoundError, ConflictError } from '../shared/errors';
import prisma from '../shared/db/client';
import { Secret } from '@prisma/client';

/** Business logic for team Secrets (write-only, masked reads). */
export class SecretsService {
  constructor(private readonly repo: SecretsRepository) {}

  /** Maps a DB row to the masked API shape — never includes the plaintext or ciphertext. */
  private toDto(row: Secret): SecretDto {
    return {
      id: row.id,
      name: row.name,
      lastFour: row.lastFour,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Creates a secret, encrypting the value at rest.
   *
   * @param teamId - Team that will own the secret.
   * @param userId - Actor creating the secret (recorded as creator + audit actor).
   * @param dto - Validated name/value pair.
   * @returns The masked secret.
   * @throws {ConflictError} If a secret with the same name already exists for the team.
   */
  async create(teamId: string, userId: string, dto: CreateSecretDto): Promise<SecretDto> {
    if (await this.repo.findByNameForTeam(dto.name, teamId)) {
      throw new ConflictError(`A secret named '${dto.name}' already exists.`);
    }
    const row = await this.repo.create({
      teamId,
      name: dto.name,
      secretCiphertext: encryptSecret(dto.value),
      lastFour: dto.value.slice(-4),
      createdBy: userId,
    });
    void audit(prisma, { teamId, actorId: userId, event: 'secret_created', metadata: { secretId: row.id, name: row.name } });
    return this.toDto(row);
  }

  /**
   * Lists a team's secrets (masked).
   *
   * @param teamId - Team to list secrets for.
   * @returns All of the team's secrets, newest first.
   */
  async list(teamId: string): Promise<SecretDto[]> {
    return (await this.repo.listByTeam(teamId)).map((r) => this.toDto(r));
  }

  /**
   * Rotates a secret's value in place, re-encrypting under the same name.
   *
   * @param id - Secret id.
   * @param teamId - Owning team, to prevent cross-team rotation.
   * @param userId - Actor performing the rotation (audit actor).
   * @param dto - The new plaintext value.
   * @returns The masked secret with its updated `lastFour`.
   * @throws {NotFoundError} If no secret with this id exists in the team.
   */
  async rotate(id: string, teamId: string, userId: string, dto: UpdateSecretDto): Promise<SecretDto> {
    const row = await this.repo.updateValue(id, teamId, encryptSecret(dto.value), dto.value.slice(-4));
    if (!row) throw new NotFoundError('Secret not found.');
    void audit(prisma, { teamId, actorId: userId, event: 'secret_rotated', metadata: { secretId: id } });
    return this.toDto(row);
  }

  /**
   * Deletes a secret, unless a tool executor still references it by name.
   *
   * @param id - Secret id.
   * @param teamId - Owning team, to prevent cross-team deletion.
   * @param userId - Actor performing the deletion (audit actor).
   * @throws {NotFoundError} If no secret with this id exists in the team.
   * @throws {ConflictError} If any committed tool version's executor references this secret.
   */
  async remove(id: string, teamId: string, userId: string): Promise<void> {
    const existing = await this.repo.findByIdForTeam(id, teamId);
    if (!existing) throw new NotFoundError('Secret not found.');
    if (await this.repo.isReferenced(existing.name, teamId)) {
      throw new ConflictError(`Secret '${existing.name}' is referenced by a tool and cannot be deleted.`);
    }
    await this.repo.delete(id, teamId);
    void audit(prisma, { teamId, actorId: userId, event: 'secret_deleted', metadata: { secretId: id, name: existing.name } });
  }
}
