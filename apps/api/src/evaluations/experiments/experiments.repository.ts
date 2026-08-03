import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';

/** An experiment row including its runs (newest first). */
export type ExperimentWithRuns = Prisma.ExperimentGetPayload<{
  include: { runs: { orderBy: { createdAt: 'desc' } } };
}>;

/**
 * Data access for the `experiments` table. The only files in this domain
 * that touch Prisma are this repository and the sibling `runs.repository.ts`.
 * All queries are team-scoped for isolation.
 */
export class ExperimentsRepository {
  /**
   * Creates an experiment for a team.
   *
   * @param teamId - Isolation boundary.
   * @param createdBy - User ID (nullable for team-scoped API key creation).
   * @param data - Experiment fields: datasetId, optional promptId/name, and the resolved sweep config.
   * @returns The created experiment row (runs will be an empty array — none exist yet).
   */
  async create(
    teamId: string,
    createdBy: string | null,
    data: {
      datasetId: string;
      promptId?: string;
      name?: string;
      config: Prisma.InputJsonValue;
    },
  ): Promise<ExperimentWithRuns> {
    return prisma.experiment.create({
      data: {
        teamId,
        datasetId: data.datasetId,
        promptId: data.promptId ?? null,
        name: data.name ?? null,
        config: data.config,
        createdBy,
      },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  /**
   * Lists a team's experiments, newest first, with their runs (also newest first).
   *
   * @param teamId - Isolation boundary.
   * @returns Array of experiments with their runs.
   */
  async list(teamId: string): Promise<ExperimentWithRuns[]> {
    return prisma.experiment.findMany({
      where: { teamId },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Gets one experiment with its runs (newest first), or null if missing.
   *
   * @param teamId - Isolation boundary.
   * @param id - Experiment UUID.
   * @returns The experiment with its runs, or null if not found or in another team.
   */
  async getById(teamId: string, id: string): Promise<ExperimentWithRuns | null> {
    return prisma.experiment.findFirst({
      where: { id, teamId },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }
}
