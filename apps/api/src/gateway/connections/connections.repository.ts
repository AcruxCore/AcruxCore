import { Prisma, provider_kind } from '@prisma/client';
import prisma from '../../shared/db/client';
import { ProviderConnection } from '../../shared/db/schema';

/**
 * Data access layer for the `provider_connections` table. The only file in this
 * domain that touches Prisma. All lookups are team-scoped for isolation.
 */
export class ConnectionsRepository {
  /**
   * Inserts a new connection row. The caller supplies already-encrypted bytes.
   *
   * @param params - teamId, provider, label, encrypted secret, keyLastFour, config, createdBy.
   * @returns The inserted row (including the encrypted `secretCiphertext`).
   */
  async create(params: {
    teamId: string;
    provider: provider_kind;
    label: string;
    secretCiphertext: Buffer;
    keyLastFour: string;
    config: Prisma.InputJsonValue;
    createdBy: string;
  }): Promise<ProviderConnection> {
    return prisma.providerConnection.create({
      data: {
        teamId: params.teamId,
        provider: params.provider,
        label: params.label,
        // Wrap in a fresh Uint8Array: Prisma types `Bytes` as `Uint8Array<ArrayBuffer>`,
        // which a Node `Buffer<ArrayBufferLike>` is not directly assignable to.
        secretCiphertext: new Uint8Array(params.secretCiphertext),
        keyLastFour: params.keyLastFour,
        config: params.config,
        createdBy: params.createdBy,
      },
    });
  }

  /**
   * Lists all connections for a team, newest first.
   *
   * @param teamId - The current team's UUID.
   */
  async listByTeam(teamId: string): Promise<ProviderConnection[]> {
    return prisma.providerConnection.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Finds one connection by id, scoped to the team. Returns undefined if it does
   * not exist or belongs to another team (so callers surface 404, not 403).
   *
   * @param id - Connection UUID.
   * @param teamId - Isolation boundary.
   */
  async findByIdForTeam(id: string, teamId: string): Promise<ProviderConnection | undefined> {
    const row = await prisma.providerConnection.findFirst({ where: { id, teamId } });
    return row ?? undefined;
  }

  /**
   * Lists a team's connections for one provider. Used by G2/G5 routing to pick a
   * credential; part of the cross-step contract though unused within G1.
   *
   * @param teamId - The team's UUID.
   * @param provider - The provider kind to filter by.
   */
  async findByTeamAndProvider(
    teamId: string,
    provider: provider_kind,
  ): Promise<ProviderConnection[]> {
    return prisma.providerConnection.findMany({
      where: { teamId, provider },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Applies a partial update and bumps `updatedAt`. Ownership must already be
   * verified by the caller (the service checks via {@link findByIdForTeam}).
   *
   * @param id - Connection UUID.
   * @param patch - Any subset of label / secretCiphertext / keyLastFour / config.
   * @returns The updated row.
   */
  async update(
    id: string,
    patch: {
      label?: string;
      secretCiphertext?: Buffer;
      keyLastFour?: string;
      config?: Prisma.InputJsonValue;
    },
  ): Promise<ProviderConnection> {
    const data: Prisma.ProviderConnectionUpdateInput = { updatedAt: new Date() };
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.keyLastFour !== undefined) data.keyLastFour = patch.keyLastFour;
    if (patch.config !== undefined) data.config = patch.config;
    // See create(): Prisma `Bytes` is `Uint8Array<ArrayBuffer>`, not a Node Buffer.
    if (patch.secretCiphertext !== undefined) {
      data.secretCiphertext = new Uint8Array(patch.secretCiphertext);
    }
    return prisma.providerConnection.update({ where: { id }, data });
  }

  /**
   * Hard-deletes a connection by id. Ownership must already be verified by the caller.
   *
   * @param id - Connection UUID.
   */
  async delete(id: string): Promise<void> {
    await prisma.providerConnection.delete({ where: { id } });
  }
}
