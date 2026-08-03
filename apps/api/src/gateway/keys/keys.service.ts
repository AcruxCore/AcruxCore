import prisma from '../../shared/db/client'; // audit-only, per Global Constraints
import { audit } from '../../shared/audit';
import { NotFoundError } from '../../shared/errors';
import { VirtualKey } from '../../shared/db/schema';
import { VirtualKeysRepository } from './keys.repository';
import { generateKey } from './keys.crypto';
import {
  CreateVirtualKeyDto,
  UpdateVirtualKeyDto,
  VirtualKeyCreatedDto,
  VirtualKeyListItemDto,
} from './keys.types';

/** Maps a stored allow-list array to the API's null-when-unrestricted shape. */
function nullIfEmpty(arr: string[]): string[] | null {
  return arr.length > 0 ? arr : null;
}

/** Projects a row to the masked list DTO (no token, no hash). */
function toListItem(row: VirtualKey): VirtualKeyListItemDto {
  return {
    id: row.id,
    name: row.name,
    keyLastFour: row.keyLastFour,
    allowedModels: nullIfEmpty(row.allowedModels),
    allowedProviders: nullIfEmpty(row.allowedProviders),
    maxRpm: row.maxRpm,
    maxTpm: row.maxTpm,
    cacheTtlSeconds: row.cacheTtlSeconds,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Business logic for virtual keys: create (returns plaintext once), list (masked),
 * update scopes/limits, and revoke. Emits audit events on create/revoke.
 */
export class VirtualKeysService {
  constructor(private readonly repo: VirtualKeysRepository) {}

  /**
   * Generates a token, stores only its hash + last four, and returns the plaintext
   * token exactly once. Emits `virtual_key_created`.
   *
   * @param teamId - Owning team.
   * @param actorId - The owner/admin creating the key (written to `created_by` + audit).
   * @param dto - Validated create body.
   * @returns The created key including the plaintext `key` (only time it is returned).
   */
  async create(teamId: string, actorId: string, dto: CreateVirtualKeyDto): Promise<VirtualKeyCreatedDto> {
    const { token, hash, lastFour } = generateKey();
    const row = await this.repo.create({
      teamId,
      name: dto.name,
      keyHash: hash,
      keyLastFour: lastFour,
      allowedModels: dto.allowedModels ?? [],
      allowedProviders: dto.allowedProviders ?? [],
      maxRpm: dto.maxRpm ?? null,
      maxTpm: dto.maxTpm ?? null,
      cacheTtlSeconds: dto.cacheTtlSeconds ?? null,
      createdBy: actorId,
    });

    await audit(prisma, {
      teamId,
      actorId,
      event: 'virtual_key_created',
      metadata: { virtualKeyId: row.id, name: row.name, allowedModels: row.allowedModels },
    });

    return {
      id: row.id,
      name: row.name,
      key: token,
      keyLastFour: row.keyLastFour,
      allowedModels: nullIfEmpty(row.allowedModels),
      allowedProviders: nullIfEmpty(row.allowedProviders),
      maxRpm: row.maxRpm,
      maxTpm: row.maxTpm,
      cacheTtlSeconds: row.cacheTtlSeconds,
      createdAt: row.createdAt,
    };
  }

  /**
   * Lists all keys (active + revoked) for a team, masked (no token/hash).
   *
   * @param teamId - Team whose keys to list.
   * @returns Masked key list items.
   */
  async list(teamId: string): Promise<VirtualKeyListItemDto[]> {
    const rows = await this.repo.listByTeam(teamId);
    return rows.map(toListItem);
  }

  /**
   * Updates a key's name/scopes/limits. Only provided fields change; allow-lists
   * of `null` clear the restriction (stored as `[]`).
   *
   * @param id - Key UUID.
   * @param teamId - Isolation boundary.
   * @param dto - Validated patch body.
   * @returns The updated key, masked.
   * @throws {NotFoundError} If the key does not exist in this team.
   */
  async update(id: string, teamId: string, dto: UpdateVirtualKeyDto): Promise<VirtualKeyListItemDto> {
    const existing = await this.repo.findByIdForTeam(id, teamId);
    if (!existing) throw new NotFoundError('Virtual key not found.');

    const patch: Parameters<VirtualKeysRepository['update']>[1] = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.allowedModels !== undefined) patch.allowedModels = dto.allowedModels ?? [];
    if (dto.allowedProviders !== undefined) patch.allowedProviders = dto.allowedProviders ?? [];
    if (dto.maxRpm !== undefined) patch.maxRpm = dto.maxRpm;
    if (dto.maxTpm !== undefined) patch.maxTpm = dto.maxTpm;
    if (dto.cacheTtlSeconds !== undefined) patch.cacheTtlSeconds = dto.cacheTtlSeconds;

    const row = await this.repo.update(id, patch);
    return toListItem(row);
  }

  /**
   * Soft-revokes a key. Idempotency: an already-revoked or unknown key → 404.
   * Emits `virtual_key_revoked`.
   *
   * @param id - Key UUID.
   * @param teamId - Isolation boundary.
   * @param actorId - The owner/admin revoking (for audit).
   * @throws {NotFoundError} If the key does not exist, or is already revoked, in this team.
   */
  async revoke(id: string, teamId: string, actorId: string): Promise<void> {
    const existing = await this.repo.findByIdForTeam(id, teamId);
    if (!existing || existing.revokedAt) throw new NotFoundError('Virtual key not found.');
    await this.repo.revoke(id);
    await audit(prisma, {
      teamId,
      actorId,
      event: 'virtual_key_revoked',
      metadata: { virtualKeyId: id },
    });
  }
}
