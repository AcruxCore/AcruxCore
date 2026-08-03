import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';

/** Include shape used everywhere: bound credential + ordered fallbacks (each with its own credential). */
const modelInclude = {
  credential: true,
  fallbacks: {
    orderBy: { position: 'asc' },
    include: { fallbackModel: { include: { credential: true } } },
  },
} satisfies Prisma.GatewayModelInclude;

/** A gateway_models row with its credential and ordered fallbacks (each fallback's credential included). */
export type GatewayModelWithRelations = Prisma.GatewayModelGetPayload<{ include: typeof modelInclude }>;

/**
 * Data access for `gateway_models` and its ordered fallback join. The only file
 * in this domain that touches Prisma. Every query is team-scoped.
 */
export class ModelsRepository {
  /**
   * Inserts a model and its ordered fallback rows in one transaction.
   *
   * @param params - Model fields plus an ordered `fallbackModelIds` list (may be empty).
   * @returns The created row with credential + fallbacks.
   */
  async create(params: {
    teamId: string;
    publicName: string;
    upstreamModel: string;
    credentialId: string;
    inputPricePerM: Prisma.Decimal | null;
    outputPricePerM: Prisma.Decimal | null;
    createdBy: string;
    fallbackModelIds: string[];
  }): Promise<GatewayModelWithRelations> {
    return prisma.$transaction(async (tx) => {
      const created = await tx.gatewayModel.create({
        data: {
          teamId: params.teamId,
          publicName: params.publicName,
          upstreamModel: params.upstreamModel,
          credentialId: params.credentialId,
          inputPricePerM: params.inputPricePerM,
          outputPricePerM: params.outputPricePerM,
          createdBy: params.createdBy,
        },
      });
      await this.writeFallbacks(tx, created.id, params.fallbackModelIds);
      return tx.gatewayModel.findUniqueOrThrow({ where: { id: created.id }, include: modelInclude });
    });
  }

  /**
   * Lists a team's models, newest first, with credential + fallbacks.
   *
   * @param teamId - The current team's UUID.
   */
  async listByTeam(teamId: string): Promise<GatewayModelWithRelations[]> {
    return prisma.gatewayModel.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      include: modelInclude,
    });
  }

  /**
   * Finds one model by id, scoped to the team. Returns undefined if missing or
   * in another team (so callers surface 404, not 403).
   *
   * @param id - Model UUID.
   * @param teamId - Isolation boundary.
   */
  async findByIdForTeam(id: string, teamId: string): Promise<GatewayModelWithRelations | undefined> {
    const row = await prisma.gatewayModel.findFirst({ where: { id, teamId }, include: modelInclude });
    return row ?? undefined;
  }

  /**
   * Routing lookup: finds a team's model by public name, with its credential and
   * ordered fallbacks (each fallback's credential loaded so it can be called).
   *
   * @param teamId - The team's UUID.
   * @param publicName - The requested `model` string.
   */
  async findByPublicName(
    teamId: string,
    publicName: string,
  ): Promise<GatewayModelWithRelations | undefined> {
    const row = await prisma.gatewayModel.findFirst({
      where: { teamId, publicName },
      include: modelInclude,
    });
    return row ?? undefined;
  }

  /**
   * Applies a partial update, optionally replacing the whole fallback set, and
   * bumps `updatedAt`. Ownership must already be verified by the caller.
   *
   * @param id - Model UUID.
   * @param patch - Any subset of publicName/upstreamModel/credentialId/prices.
   * @param fallbackModelIds - When provided, replaces the ordered fallback set.
   * @returns The updated row with relations.
   */
  async update(
    id: string,
    patch: {
      publicName?: string;
      upstreamModel?: string;
      credentialId?: string;
      inputPricePerM?: Prisma.Decimal | null;
      outputPricePerM?: Prisma.Decimal | null;
    },
    fallbackModelIds?: string[],
  ): Promise<GatewayModelWithRelations> {
    return prisma.$transaction(async (tx) => {
      const data: Prisma.GatewayModelUpdateInput = { updatedAt: new Date() };
      if (patch.publicName !== undefined) data.publicName = patch.publicName;
      if (patch.upstreamModel !== undefined) data.upstreamModel = patch.upstreamModel;
      if (patch.credentialId !== undefined) {
        data.credential = { connect: { id: patch.credentialId } };
      }
      if (patch.inputPricePerM !== undefined) data.inputPricePerM = patch.inputPricePerM;
      if (patch.outputPricePerM !== undefined) data.outputPricePerM = patch.outputPricePerM;

      await tx.gatewayModel.update({ where: { id }, data });

      if (fallbackModelIds !== undefined) {
        await tx.gatewayModelFallback.deleteMany({ where: { modelId: id } });
        await this.writeFallbacks(tx, id, fallbackModelIds);
      }
      return tx.gatewayModel.findUniqueOrThrow({ where: { id }, include: modelInclude });
    });
  }

  /**
   * Hard-deletes a model; its fallback rows cascade. Ownership pre-verified by caller.
   * @throws {Prisma.PrismaClientKnownRequestError} P2003 if a gateway_request still references it — but
   *   the FK is `SET NULL`, so this does not occur; delete is blocked earlier via {@link isFallbackOfAny}.
   */
  async delete(id: string): Promise<void> {
    await prisma.gatewayModel.delete({ where: { id } });
  }

  /**
   * Whether this model is used as another model's fallback (blocks deletion).
   *
   * @param id - Model UUID.
   */
  async isFallbackOfAny(id: string): Promise<boolean> {
    const count = await prisma.gatewayModelFallback.count({ where: { fallbackModelId: id } });
    return count > 0;
  }

  /**
   * Counts how many of the given ids are models in this team (fallback validation).
   *
   * @param teamId - Isolation boundary.
   * @param ids - Candidate model ids.
   * @returns The set of ids that exist in the team.
   */
  async existingIdsInTeam(teamId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await prisma.gatewayModel.findMany({
      where: { teamId, id: { in: ids } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  // Writes the ordered fallback rows for a model. `position` is the array index.
  private async writeFallbacks(
    tx: Prisma.TransactionClient,
    modelId: string,
    fallbackModelIds: string[],
  ): Promise<void> {
    if (fallbackModelIds.length === 0) return;
    await tx.gatewayModelFallback.createMany({
      data: fallbackModelIds.map((fallbackModelId, position) => ({ modelId, fallbackModelId, position })),
    });
  }
}
