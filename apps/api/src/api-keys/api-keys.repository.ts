import { Prisma } from '@prisma/client';
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
   * Resolves a presented API key to its owning user, its team, **and** that user's
   * current role in that team, in one round trip.
   *
   * Revoked keys are excluded here rather than by the caller, so an unknown key and a
   * revoked key are indistinguishable to callers — that is deliberate, to avoid
   * leaking whether a key ever existed.
   *
   * The membership is joined rather than looked up separately because it is needed on
   * every single authenticated request: `requireApiKey` must confirm a personal key's
   * owner is still in the key's team (`api_keys.team_id` is denormalized, and nothing
   * revoked a key when its owner was removed), and `requireRole` then needs that same
   * member's role microseconds later. Three serial queries became one; both sides of
   * the join are index-only (`api_keys.key_hash` is unique,
   * `team_members(user_id, team_id)` is unique). It also keeps this the only file in
   * the domain that touches Prisma, which the middleware doing its own lookup did not.
   *
   * @param keyHash - sha256 hex of the token the caller presented.
   * @returns The active row with the owner's email, display name and team role, or
   *   undefined if the hash is unknown or the key is revoked. `membershipRole` is
   *   null for a team-scoped key (no owner) and for a personal key whose owner has
   *   since been removed from the team — the caller must reject the latter.
   */
  async findActiveByHash(keyHash: string): Promise<
    | {
        id: string;
        userId: string | null;
        teamId: string;
        scope: string;
        user: { email: string; displayName: string | null } | null;
        membershipRole: string | null;
      }
    | undefined
  > {
    const rows = await prisma.$queryRaw<
      {
        id: string;
        user_id: string | null;
        team_id: string;
        scope: string;
        email: string | null;
        display_name: string | null;
        role: string | null;
      }[]
    >(Prisma.sql`
      SELECT k.id,
             k.user_id,
             k.team_id,
             k.scope,
             u.email,
             u.display_name,
             m.role::text AS role
      FROM api_keys k
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN team_members m ON m.user_id = k.user_id AND m.team_id = k.team_id
      WHERE k.key_hash = ${keyHash} AND k.revoked_at IS NULL
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      teamId: row.team_id,
      scope: row.scope,
      user: row.email !== null ? { email: row.email, displayName: row.display_name } : null,
      membershipRole: row.role,
    };
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
