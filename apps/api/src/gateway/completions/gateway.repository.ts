import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';
import type { GatewayRequestRow } from '../../shared/db/schema';
import type { RecordRequestInput } from './completions.types';

/**
 * Data-access class for the gateway_requests table. The only file importing prisma
 * for this table. Consumed by GatewayService (G2) and every later gateway step.
 */
export class GatewayRepository {
  /**
   * Insert one gateway_requests row (success, error, or cache_hit).
   *
   * @param input - All row fields; optional numeric/id fields default to null.
   * @param tx - Optional Prisma transaction client. When provided, the insert runs
   *   inside that transaction (used by G4's budget-increment `$transaction`); a no-op
   *   in G2 where it defaults to the shared prisma client.
   * @returns The inserted row.
   */
  async recordRequest(input: RecordRequestInput, tx?: Prisma.TransactionClient): Promise<GatewayRequestRow> {
    const client = tx ?? prisma;
    return client.gatewayRequest.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        teamId: input.teamId,
        virtualKeyId: input.virtualKeyId ?? null,
        providerConnectionId: input.providerConnectionId ?? null,
        gatewayModelId: input.gatewayModelId ?? null,
        provider: input.provider ?? null,
        requestedModel: input.requestedModel,
        resolvedModel: input.resolvedModel ?? null,
        status: input.status,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.totalTokens,
        costUsd: input.costUsd ?? null,
        latencyMs: input.latencyMs ?? null,
        cacheHit: input.cacheHit,
        promptVersionId: input.promptVersionId ?? null,
        errorCode: input.errorCode ?? null,
        meta: (input.meta ?? {}) as Prisma.InputJsonValue, // ← G5 fallback telemetry
      },
    });
  }

  /**
   * Reads one gateway_requests row by id. Used by the T1 trace hook to mirror the
   * committed ledger row's authoritative fields (tokens/cost/latency/provider/
   * model/prompt_version_id/status) onto its span.
   *
   * @param id - The gateway_requests row id.
   * @param tx - Optional transaction client (the hook reads inside its own tx).
   * @returns The row, or null if not found.
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<GatewayRequestRow | null> {
    const client = tx ?? prisma;
    return client.gatewayRequest.findUnique({ where: { id } });
  }
}
