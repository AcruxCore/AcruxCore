import { ApiKeysRepository } from './api-keys.repository';
import { generateKey } from './api-keys.crypto';
import { CreateApiKeyDto, ApiKeyCreatedDto, ApiKeyListItemDto } from './api-keys.types';
import { NotFoundError } from '../shared/errors';
import { audit } from '../shared/audit';
import prisma from '../shared/db/client';

/**
 * Business logic for API key management.
 * Key generation, listing (with key masking), and revocation.
 */
export class ApiKeysService {
  constructor(private readonly repo: ApiKeysRepository) {}

  /**
   * Mints an `acx_sk_…` API key, persists only its sha256 hash plus the last
   * four characters, and returns the token in full — the only time the full
   * value is ever available, since it cannot be recovered from the database.
   *
   * @param userId - The authenticated user's ID.
   * @param teamId - The active team's ID.
   * @param dto - Optional `name` for the key.
   */
  async create(
    userId: string,
    teamId: string,
    dto: CreateApiKeyDto,
  ): Promise<ApiKeyCreatedDto> {
    const { token, hash, lastFour } = generateKey();
    const row = await this.repo.create({
      userId,
      teamId,
      keyHash: hash,
      keyLastFour: lastFour,
      name: dto.name,
    });

    await audit(prisma, {
      teamId,
      actorId: userId,
      event: 'api_key_generated',
      metadata: { apiKeyId: row.id, name: row.name },
    });

    return {
      id: row.id,
      // From the generated token, never the row — the row has no plaintext.
      key: token,
      name: row.name,
      createdAt: row.createdAt,
    };
  }

  /**
   * Lists all active keys for the user+team, returning only the last 4 chars of each key.
   *
   * @param userId - The authenticated user's ID.
   * @param teamId - The active team's ID.
   */
  async list(userId: string, teamId: string): Promise<ApiKeyListItemDto[]> {
    const rows = await this.repo.listActive(userId, teamId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      lastFour: row.keyLastFour,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Revokes an API key, verifying it belongs to the caller.
   *
   * @param id - The key UUID to revoke.
   * @param userId - Ownership check — must match the key's user_id.
   * @param teamId - Ownership check — must match the key's team_id.
   * @throws {NotFoundError} If the key doesn't exist, is already revoked, or belongs to another user/team.
   */
  async revoke(id: string, userId: string, teamId: string): Promise<void> {
    const row = await this.repo.findActiveById(id, userId, teamId);
    if (!row) {
      throw new NotFoundError('API key not found.');
    }
    await this.repo.revoke(id);

    await audit(prisma, {
      teamId,
      actorId: userId,
      event: 'api_key_revoked',
      metadata: { apiKeyId: id },
    });
  }

  /**
   * Generates a team-scoped API key (no user identity).
   * Team keys can read prompts and call the render/versions endpoints but
   * cannot manage members or create other keys.
   *
   * @param teamId - The team to create the key for.
   * @param dto    - Optional name for the key.
   * @returns The created key in full (only time it is returned).
   */
  async createTeamApiKey(
    teamId: string,
    dto: CreateApiKeyDto,
  ): Promise<ApiKeyCreatedDto> {
    const { token, hash, lastFour } = generateKey();
    const row = await this.repo.createTeamKey({
      teamId,
      keyHash: hash,
      keyLastFour: lastFour,
      name: dto.name,
    });
    return { id: row.id, key: token, name: row.name, createdAt: row.createdAt };
  }

  /**
   * Lists active team-scoped keys for a team, masking all but the last 4 chars.
   *
   * @param teamId - The team whose keys to list.
   */
  async listTeamApiKeys(teamId: string): Promise<ApiKeyListItemDto[]> {
    const rows = await this.repo.listActiveTeamKeys(teamId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      lastFour: row.keyLastFour,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Revokes a team-scoped API key by ID, verifying it belongs to the team.
   *
   * @param id     - Key UUID to revoke.
   * @param teamId - Isolation boundary.
   * @throws {NotFoundError} If the key is not found, already revoked, or belongs to a different team.
   */
  async revokeTeamApiKey(id: string, teamId: string): Promise<void> {
    const row = await this.repo.findActiveTeamKeyById(id, teamId);
    if (!row) throw new NotFoundError('API key not found.');
    await this.repo.revoke(id);
  }
}
