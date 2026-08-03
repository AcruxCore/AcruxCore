import { Secret } from '@prisma/client';
import prisma from '../shared/db/client';

interface CreateParams {
  teamId: string;
  name: string;
  secretCiphertext: Buffer;
  lastFour: string;
  createdBy: string;
}

/** All DB access for team Secrets. The only file in the domain that touches Prisma. */
export class SecretsRepository {
  /**
   * Inserts a new secret.
   *
   * @param p - Team, name, encrypted value, masked last-four, and creator.
   * @returns The created row.
   */
  async create(p: CreateParams): Promise<Secret> {
    return prisma.secret.create({
      data: {
        teamId: p.teamId,
        name: p.name,
        secretCiphertext: new Uint8Array(p.secretCiphertext),
        lastFour: p.lastFour,
        createdBy: p.createdBy,
      },
    });
  }

  /**
   * Lists a team's secrets, newest first.
   *
   * @param teamId - The owning team.
   * @returns All secret rows for the team.
   */
  async listByTeam(teamId: string): Promise<Secret[]> {
    return prisma.secret.findMany({ where: { teamId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Finds one secret by id within a team.
   *
   * @param id - Secret id.
   * @param teamId - Owning team, to prevent cross-team access.
   * @returns The row, or undefined if not found (or not in this team).
   */
  async findByIdForTeam(id: string, teamId: string): Promise<Secret | undefined> {
    return (await prisma.secret.findFirst({ where: { id, teamId } })) ?? undefined;
  }

  /**
   * Finds one secret by name within a team (used at execution time to inject a value).
   *
   * @param name - Secret name (e.g. `WEATHER_KEY`).
   * @param teamId - Owning team.
   * @returns The row, or undefined if not found.
   */
  async findByNameForTeam(name: string, teamId: string): Promise<Secret | undefined> {
    return (await prisma.secret.findFirst({ where: { name, teamId } })) ?? undefined;
  }

  /**
   * Rotates a secret's value in place.
   *
   * @param id - Secret id.
   * @param teamId - Owning team, to prevent cross-team access.
   * @param secretCiphertext - The newly encrypted value.
   * @param lastFour - The new masked suffix.
   * @returns The updated row, or undefined if not found.
   */
  async updateValue(
    id: string,
    teamId: string,
    secretCiphertext: Buffer,
    lastFour: string,
  ): Promise<Secret | undefined> {
    const { count } = await prisma.secret.updateMany({
      where: { id, teamId },
      data: { secretCiphertext: new Uint8Array(secretCiphertext), lastFour, updatedAt: new Date() },
    });
    if (count === 0) return undefined;
    return (await prisma.secret.findUnique({ where: { id } })) ?? undefined;
  }

  /**
   * Deletes a secret.
   *
   * @param id - Secret id.
   * @param teamId - Owning team, to prevent cross-team access.
   * @returns True if a row was deleted, false if none matched.
   */
  async delete(id: string, teamId: string): Promise<boolean> {
    const { count } = await prisma.secret.deleteMany({ where: { id, teamId } });
    return count > 0;
  }

  /**
   * True if any committed tool version's executor references this secret by name
   * (`{{secret.NAME}}`), scoped to the team. Used to block deletion (409).
   * Soft-deleted tools are excluded — otherwise a secret becomes permanently
   * undeletable once a tool that used it is removed.
   *
   * @param name - Secret name to search for in executor JSON.
   * @param teamId - Owning team, to scope the search to that team's tools.
   * @returns Whether at least one tool version's executor references the secret.
   */
  async isReferenced(name: string, teamId: string): Promise<boolean> {
    const ref = `%{{secret.${name}}}%`;
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM tool_versions tv
      JOIN tools t ON t.id = tv.tool_id
      WHERE t.team_id = ${teamId}::uuid AND t.deleted_at IS NULL AND tv.executor::text LIKE ${ref}`;
    return (rows[0]?.count ?? 0n) > 0n;
  }
}
