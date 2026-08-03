import prisma from '../../shared/db/client';
import { VirtualKey } from '../../shared/db/schema';

/**
 * All database access for the `virtual_keys` table. The only file in this domain
 * that imports prisma. Ownership/team filters live here.
 */
export class VirtualKeysRepository {
  /**
   * Inserts a new virtual-key row. The caller (service) generates the token and
   * passes only the hash + last four; the plaintext token is never persisted.
   *
   * @param p - Row fields. `allowedModels`/`allowedProviders` are `[]` when unrestricted.
   * @returns The inserted row.
   */
  async create(p: {
    teamId: string;
    name: string;
    keyHash: string;
    keyLastFour: string;
    allowedModels: string[];
    allowedProviders: string[];
    maxRpm: number | null;
    maxTpm: number | null;
    cacheTtlSeconds: number | null;
    createdBy: string;
  }): Promise<VirtualKey> {
    return prisma.virtualKey.create({
      data: {
        teamId: p.teamId,
        name: p.name,
        keyHash: p.keyHash,
        keyLastFour: p.keyLastFour,
        allowedModels: p.allowedModels,
        allowedProviders: p.allowedProviders,
        maxRpm: p.maxRpm,
        maxTpm: p.maxTpm,
        cacheTtlSeconds: p.cacheTtlSeconds,
        createdBy: p.createdBy,
      },
    });
  }

  /**
   * Lists all keys for a team — active and revoked — newest first. Used by the
   * masked list endpoint; the service strips the hash.
   *
   * @param teamId - Team whose keys to list.
   * @returns All key rows for the team, ordered newest first.
   */
  async listByTeam(teamId: string): Promise<VirtualKey[]> {
    return prisma.virtualKey.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Resolves an ACTIVE key by its hash for gateway auth. Team-agnostic by design:
   * the hash is globally unique, and the returned row's `teamId` is the caller's
   * team context. Revoked keys (`revokedAt` set) never resolve.
   *
   * @param keyHash - sha256 hex of the presented token.
   * @returns The active key row, or undefined if unknown or revoked.
   */
  async findActiveByHash(keyHash: string): Promise<VirtualKey | undefined> {
    const row = await prisma.virtualKey.findFirst({
      where: { keyHash, revokedAt: null },
    });
    return row ?? undefined;
  }

  /**
   * Finds a key by id scoped to a team (management ownership check). Returns
   * revoked keys too, so callers can 404-vs-already-revoked as they see fit.
   *
   * @param id - Key UUID.
   * @param teamId - Isolation boundary.
   * @returns The matching row, or undefined.
   */
  async findByIdForTeam(id: string, teamId: string): Promise<VirtualKey | undefined> {
    const row = await prisma.virtualKey.findFirst({ where: { id, teamId } });
    return row ?? undefined;
  }

  /**
   * Applies a partial update to a key's mutable fields. Ownership must be
   * verified by the caller first (via `findByIdForTeam`).
   *
   * @param id - Key UUID.
   * @param patch - Fields to change (only provided keys are written).
   * @returns The updated row.
   */
  async update(
    id: string,
    patch: Partial<{
      name: string;
      allowedModels: string[];
      allowedProviders: string[];
      maxRpm: number | null;
      maxTpm: number | null;
      cacheTtlSeconds: number | null;
    }>,
  ): Promise<VirtualKey> {
    return prisma.virtualKey.update({ where: { id }, data: patch });
  }

  /**
   * Soft-revokes a key by stamping `revoked_at`. Historical `gateway_requests`
   * keep their FK (revocation is soft).
   *
   * @param id - Key UUID (ownership already verified by the caller).
   */
  async revoke(id: string): Promise<void> {
    await prisma.virtualKey.update({ where: { id }, data: { revokedAt: new Date() } });
  }
}
