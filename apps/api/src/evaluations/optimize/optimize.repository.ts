import { Prisma } from '@prisma/client';
import prisma from '../../shared/db/client';

const CANDIDATE_FOR_RUN_INCLUDE = {
  prompt: { select: { name: true } },
  version: { select: { versionNumber: true } },
} satisfies Prisma.PromptCandidateInclude;

/** A candidate row with its prompt's name and its committed version number, if any. */
export type CandidateForRun = Prisma.PromptCandidateGetPayload<{ include: typeof CANDIDATE_FOR_RUN_INCLUDE }>;

/**
 * Data access for the `prompt_candidates` table. The only file in this
 * domain that touches Prisma. Candidates are always created team-scoped and
 * tied to the optimize run that drafted them (`experimentRunId`); listing is
 * team-scoped too, so a queue payload carrying another team's run id can
 * never leak candidates across tenants.
 */
export class OptimizeRepository {
  /**
   * Persists one optimizer-drafted candidate rewrite.
   *
   * @param data - Candidate identity (team/prompt/run), its rendered
   *   `messages` template, the optimizer's `rationale` for the rewrite, a
   *   display `label` (e.g. `candidate-A`), and the acting user id (nullable
   *   for team-scoped API key callers).
   * @returns The created `prompt_candidates` row.
   */
  async createCandidate(data: {
    teamId: string;
    promptId: string;
    experimentRunId: string;
    messages: Prisma.InputJsonValue;
    rationale: string;
    label: string;
    createdBy: string | null;
  }): Promise<Prisma.PromptCandidateGetPayload<{}>> {
    return prisma.promptCandidate.create({
      data: {
        teamId: data.teamId,
        promptId: data.promptId,
        experimentRunId: data.experimentRunId,
        messages: data.messages,
        rationale: data.rationale,
        label: data.label,
        createdBy: data.createdBy,
      },
    });
  }

  /**
   * Lists the candidates drafted for one optimize run, team-scoped, in
   * creation order (matches the `candidate-A`, `candidate-B`, ... draft order).
   *
   * @param teamId - Isolation boundary.
   * @param runId - The `experiment_runs` id the candidates were drafted for.
   * @returns The run's candidate rows, oldest first.
   */
  async listCandidatesForRun(teamId: string, runId: string): Promise<Prisma.PromptCandidateGetPayload<{}>[]> {
    return prisma.promptCandidate.findMany({
      where: { teamId, experimentRunId: runId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Reads one candidate scoped to team — the read `cell.processor.ts` uses to
   * render a `'candidate'` cell's template (E6 Task 4). Team-scoped for the
   * same reason `VersionsRepository.findByIdForTeam` is: `promptCandidateId`
   * arrives from a queue payload, so a cross-team id must resolve to nothing
   * rather than leak another team's drafted rewrite.
   *
   * @param teamId - Isolation boundary.
   * @param id - `prompt_candidates` row UUID.
   * @returns The candidate row, or `null` if not found or owned by another team.
   */
  async getCandidateById(teamId: string, id: string): Promise<Prisma.PromptCandidateGetPayload<{}> | null> {
    return prisma.promptCandidate.findFirst({
      where: { id, teamId },
    });
  }

  /**
   * Reads one candidate scoped to BOTH team and the optimize run it was
   * drafted for — used by `OptimizeService.promoteCandidate` (E6 Task 5) to
   * resolve `POST /runs/:id/promote`'s `prompt_candidate_id`. Narrower than
   * {@link getCandidateById}: a team can have candidates from multiple
   * optimize runs (e.g. the same prompt optimized more than once, or several
   * prompts each optimized once), so team-scoping alone would let a
   * `POST /runs/:id/promote` call promote a candidate drafted for a
   * DIFFERENT run than the one named in the URL. Team-scoping is still
   * checked explicitly (not just `experimentRunId`) so a foreign team's run
   * id can never be combined with this team's candidate id either.
   *
   * @param teamId - Isolation boundary.
   * @param runId - The `experiment_runs` id the candidate must have been drafted for.
   * @param id - `prompt_candidates` row UUID.
   * @returns The candidate row with its prompt's name and, once committed, its
   *   version number (one query, so a read or a commit needs no second lookup),
   *   or `null` if not found, owned by another team, or drafted for a different run.
   */
  async getCandidateForRun(teamId: string, runId: string, id: string): Promise<CandidateForRun | null> {
    return prisma.promptCandidate.findFirst({
      where: { id, teamId, experimentRunId: runId },
      include: CANDIDATE_FOR_RUN_INCLUDE,
    });
  }

  /**
   * Gives a candidate its prompt version exactly once, however many callers
   * commit or promote it at the same moment. The candidate row is locked for
   * the whole check-then-commit, so a second caller waits, then sees the
   * first caller's version instead of committing its own. Without the lock,
   * racing callers each compute the same next version number: one wins and the
   * rest fail on the unique (prompt, version number) index, or, spread a little
   * further apart, each leave a version in the prompt's history.
   *
   * `commit` gets the transaction and must write on it alone. Each caller
   * waiting on the lock holds a pooled connection, so with as many waiters as
   * the pool has connections, a `commit` that asked the pool for another one
   * would wait behind them until every transaction timed out. Writing on `tx`
   * also makes the version and the candidate's link to it one atomic change.
   *
   * @param teamId - Isolation boundary.
   * @param id - `prompt_candidates` row UUID; the caller has checked it exists.
   * @param commit - Creates the version on `tx` and returns its id and number.
   *   Runs only when the candidate has none yet, while the lock is held, so it
   *   must be quick: do every read before calling this.
   * @returns The candidate's version id and number, and whether `commit` created it.
   * @throws Whatever `commit` throws; nothing it wrote is kept.
   */
  async commitVersionOnce(
    teamId: string,
    id: string,
    commit: (tx: Prisma.TransactionClient) => Promise<{ id: string; versionNumber: number }>,
  ): Promise<{ versionId: string; versionNumber: number; created: boolean }> {
    return prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ version_id: string | null }>>`
          SELECT version_id FROM prompt_candidates
          WHERE id = ${id}::uuid AND team_id = ${teamId}::uuid
          FOR UPDATE`;
        if (row?.version_id) {
          // A statement of its own: a waiter woken by the lock re-reads only the
          // locked row, so a join here would still miss the version just committed.
          const version = await tx.promptVersion.findUniqueOrThrow({
            where: { id: row.version_id },
            select: { versionNumber: true },
          });
          return { versionId: row.version_id, versionNumber: version.versionNumber, created: false };
        }

        const version = await commit(tx);
        await tx.promptCandidate.update({ where: { id }, data: { versionId: version.id } });
        return { versionId: version.id, versionNumber: version.versionNumber, created: true };
      },
      // Waiting callers queue on the lock while the first one commits.
      { maxWait: 10_000, timeout: 20_000 },
    );
  }
}
