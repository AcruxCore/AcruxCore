import prisma from '../shared/db/client';
import { ApiKey } from '../shared/db/schema';

/**
 * Data access layer for the api_keys table.
 */
export class ApiKeysRepository {
  /**
   * Inserts a new personal API key row. The caller generates the token and
   * passes only its hash — the plaintext never reaches this layer.
   *
   * @param params - userId, teamId, sha256 hash of the token, its last four
   *   characters, and an optional name.
   * @returns The newly inserted row (contains no recoverable secret).
   */
  async create(params: {
    userId: string;
    teamId: string;
    keyHash: string;
    keyLastFour: string;
    name?: string;
  }): Promise<ApiKey> {
    return prisma.apiKey.create({
      data: {
        userId: params.userId,
        teamId: params.teamId,
        keyHash: params.keyHash,
        keyLastFour: params.keyLastFour,
        name: params.name ?? null,
      },
    });
  }

  /**
   * Lists all active (non-revoked) API keys for the given user+team pair.
   * Does NOT return the key value — callers must derive `lastFour` from the row.
   *
   * @param userId - The requesting user's UUID.
   * @param teamId - The current team's UUID.
   */
  async listActive(userId: string, teamId: string): Promise<ApiKey[]> {
    return prisma.apiKey.findMany({
      where: {
        userId,
        teamId,
        revokedAt: null,
      },
    });
  }

  /**
   * Finds a single active key by ID for the given user+team pair.
   * Returns undefined if the key doesn't exist, is already revoked, or belongs to a different user/team.
   *
   * @param id - The key's UUID.
   * @param userId - Ownership check.
   * @param teamId - Ownership check.
   */
  async findActiveById(
    id: string,
    userId: string,
    teamId: string,
  ): Promise<ApiKey | undefined> {
    const row = await prisma.apiKey.findFirst({
      where: {
        id,
        userId,
        teamId,
        revokedAt: null,
      },
    });
    return row ?? undefined;
  }

  /**
   * Resolves a presented API key to its owning user and team by hash.
   *
   * Revoked keys are excluded here rather than by the caller, so an unknown key
   * and a revoked key are indistinguishable to callers — that is deliberate, to
   * avoid leaking whether a key ever existed.
   *
   * @param keyHash - sha256 hex of the token the caller presented.
   * @returns The active row with the owner's email and display name, or
   *   undefined if the hash is unknown or the key is revoked.
   */
  async findActiveByHash(keyHash: string): Promise<
    | {
        id: string;
        userId: string | null;
        teamId: string;
        scope: string;
        user: { email: string; displayName: string | null } | null;
      }
    | undefined
  > {
    const row = await prisma.apiKey.findFirst({
      where: { keyHash, revokedAt: null },
      select: {
        id: true,
        userId: true,
        teamId: true,
        scope: true,
        user: { select: { email: true, displayName: true } },
      },
    });
    return row ?? undefined;
  }

  /**
   * Soft-deletes a key by setting `revoked_at` to the current timestamp.
   * Assumes ownership has already been verified by the caller.
   *
   * @param id - The key's UUID.
   */
  async revoke(id: string): Promise<void> {
    await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Creates a team-scoped API key (scope='team', userId=NULL).
   * Team keys authenticate on behalf of the team, not a specific user.
   *
   * @param params - teamId, sha256 hash of the token, its last four characters,
   *   and an optional human-readable label.
   * @returns The created row (contains no recoverable secret).
   */
  async createTeamKey(params: {
    teamId: string;
    keyHash: string;
    keyLastFour: string;
    name?: string;
  }): Promise<ApiKey> {
    return prisma.apiKey.create({
      data: {
        teamId: params.teamId,
        userId: null,
        keyHash: params.keyHash,
        keyLastFour: params.keyLastFour,
        name: params.name ?? null,
        scope: 'team',
      },
    });
  }

  /**
   * Lists active (non-revoked) team-scoped keys for a team.
   *
   * @param teamId - The team whose keys to list.
   * @returns Array of active team keys.
   */
  async listActiveTeamKeys(teamId: string): Promise<ApiKey[]> {
    return prisma.apiKey.findMany({
      where: { teamId, userId: null, scope: 'team', revokedAt: null },
    });
  }

  /**
   * Finds a single active team key by ID for the given team.
   *
   * @param id     - Key UUID.
   * @param teamId - Isolation: only matches keys in this team.
   * @returns The key row or undefined if not found / wrong team / revoked.
   */
  async findActiveTeamKeyById(id: string, teamId: string): Promise<ApiKey | undefined> {
    const row = await prisma.apiKey.findFirst({
      where: { id, teamId, userId: null, scope: 'team', revokedAt: null },
    });
    return row ?? undefined;
  }
}
