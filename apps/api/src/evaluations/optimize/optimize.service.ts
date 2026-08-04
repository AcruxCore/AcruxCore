import { Prisma } from '@prisma/client';
import { ExperimentsRepository } from '../experiments/experiments.repository';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { DatasetsService } from '../datasets/datasets.service';
import { RunsRepository } from '../runs/runs.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { OptimizeRepository } from './optimize.repository';
import { VersionsService } from '../../prompts/versions/versions.service';
import { AliasesService } from '../../prompts/aliases/aliases.service';
import { getOptimizeQueue, type OptimizeJobData } from '../queue';
import { NotFoundError, UnprocessableError } from '../../shared/errors';
import type { ExperimentConfig } from '../experiments/experiments.types';
import type { RunSnapshotExample } from '../runs/runs.types';
import type { StartOptimizeDto, PromoteCandidateDto, CandidateDetail } from './optimize.types';
import type { VersionDetail } from '../../prompts/versions/versions.types';
import type { AliasDetail } from '../../prompts/aliases/aliases.types';
import type { PromptMismatchWarning } from '../datasets/datasets.types';

/** Default number of candidate rewrites requested when `draft_count` is omitted. */
const DEFAULT_DRAFT_COUNT = 3;

/** Hard cap on `draft_count` — protects the optimizer call and downstream grid size. */
const MAX_DRAFT_COUNT = 6;

/** Response DTO for `POST /prompts/:promptId/optimize`. */
export interface StartOptimizeResult {
  runId: string;
  status: string;
  promptMismatchWarning?: PromptMismatchWarning;
}

/** Response DTO for `POST /runs/:id/promote` (E6 Task 5). */
export interface PromoteCandidateResult {
  version: VersionDetail;
  alias: AliasDetail;
}

/**
 * Business logic for kicking off an optimize attempt. Deliberately does only
 * the work that must happen synchronously inside the HTTP request — validate
 * the request, snapshot the dataset (its examples don't change once frozen,
 * same reasoning as `RunsService.startRun`), create the experiment + a
 * `queued` run, and enqueue an `EVAL_OPTIMIZE_QUEUE` job — then returns
 * immediately. Everything that depends on the optimizer's own LLM call
 * (drafting candidates, resolving the grid, enqueuing the cell/finalize Flow)
 * happens later, out of the request path, in `processOptimize`
 * (`apps/api/src/evaluations/runs/optimize.processor.ts`) — unlike
 * `RunsService.startRun`, which CAN resolve its whole grid synchronously
 * because it never needs to wait on an LLM response first.
 */
export class OptimizeService {
  constructor(
    private readonly experimentsRepo: ExperimentsRepository,
    private readonly datasetsRepo: DatasetsRepository,
    private readonly runsRepo: RunsRepository,
    private readonly promptsRepo: PromptsRepository,
    private readonly optimizeRepo: OptimizeRepository,
    private readonly versionsService: VersionsService,
    private readonly aliasesService: AliasesService,
  ) {}

  /**
   * Starts a new optimize attempt for a prompt: validates `draft_count`,
   * verifies the prompt and dataset belong to the team, freezes the dataset's
   * examples into `exampleSnapshot`, creates an experiment + a `queued` run
   * (with a placeholder empty `grid` — the real grid is not known until
   * `processOptimize` drafts candidates), and enqueues the optimize job.
   *
   * @param teamId - Isolation boundary.
   * @param userId - The acting user's id (nullable for team-scoped API key
   *   callers); threaded through to `OptimizeJobData.userId` so
   *   `processOptimize` can stamp it as each candidate's `createdBy`.
   * @param promptId - UUID of the prompt whose production version is being optimized.
   * @param dto - Validated payload: dataset id, models to sweep, optional draft_count.
   * @returns The created run's id and its initial `queued` status.
   * @throws {UnprocessableError} If `draft_count` exceeds {@link MAX_DRAFT_COUNT}.
   * @throws {NotFoundError} If the prompt or dataset does not resolve for this team.
   */
  async startOptimize(
    teamId: string,
    userId: string | null,
    promptId: string,
    dto: StartOptimizeDto,
  ): Promise<StartOptimizeResult> {
    const draftCount = dto.draft_count ?? DEFAULT_DRAFT_COUNT;
    if (draftCount > MAX_DRAFT_COUNT) {
      throw new UnprocessableError(`draft_count must be at most ${MAX_DRAFT_COUNT}.`);
    }

    const prompt = await this.promptsRepo.findById(promptId, teamId);
    if (!prompt) throw new NotFoundError('Prompt not found.');

    const dataset = await this.datasetsRepo.getDatasetById(teamId, dto.dataset_id);
    if (!dataset) throw new NotFoundError('Dataset not found.');

    const promptMismatchWarning = await new DatasetsService(this.datasetsRepo).checkPromptMismatch(
      dataset.examples,
      promptId,
      teamId,
    );

    // No upfront (version x model) sweep exists yet for an optimize-triggered
    // experiment — the candidates it will sweep don't exist until
    // `processOptimize`'s gateway call returns. `versionIds: []` is a
    // deliberate placeholder: `ExperimentsRepository.create` stores whatever
    // `config` it is given verbatim (it is not re-validated against
    // `CreateExperimentSchema`'s `min(1)` shape rule, which only guards the
    // plain `POST /experiments` endpoint), and nothing reads
    // `Experiment.config` for an optimize run — the real, authoritative grid
    // lives on `ExperimentRun.grid` instead, resolved by `processOptimize`.
    const config: ExperimentConfig = { versionIds: [], models: dto.models };
    const experiment = await this.experimentsRepo.create(teamId, userId, {
      datasetId: dto.dataset_id,
      promptId,
      name: 'optimize',
      config: config as unknown as Prisma.InputJsonValue,
    });

    const exampleSnapshot: RunSnapshotExample[] = dataset.examples.map((example) => ({
      exampleId: example.id,
      input: example.input as Record<string, unknown>,
      criteria: example.criteria,
      history: example.history as unknown as RunSnapshotExample['history'],
    }));

    const run = await this.runsRepo.createRun(teamId, experiment.id, {
      exampleSnapshot: exampleSnapshot as unknown as Prisma.InputJsonValue,
      // Placeholder — overwritten by `RunsRepository.setRunGrid` once
      // `processOptimize` resolves the real (candidate + production) x model grid.
      grid: [] as unknown as Prisma.InputJsonValue,
      // Recorded so the run-finished email reaches whoever started the optimize.
      createdBy: userId,
    });

    const jobData: OptimizeJobData = {
      teamId,
      userId,
      promptId,
      experimentId: experiment.id,
      runId: run.id,
      datasetId: dto.dataset_id,
      models: dto.models,
      alias: dto.alias,
      draftCount,
    };
    // Note: the optimize job runs at BullMQ `attempts: 1` (default) on purpose.
    // `processOptimize` is NOT idempotent — a whole-job retry after candidates
    // were already persisted would create duplicate `candidate-A`/`candidate-B`
    // rows. The transient failure worth retrying is the optimizer's single
    // gateway call, which `processOptimize` retries in-function (before any DB
    // write), so job-level retries are neither needed nor safe here.
    await getOptimizeQueue().add('optimize', jobData);

    return { runId: run.id, status: 'queued', ...(promptMismatchWarning ? { promptMismatchWarning } : {}) };
  }

  /**
   * Promotes one optimizer-drafted candidate to a real, immutable
   * `PromptVersion` and moves an alias (default `production`) to point at
   * it — the human-in-the-loop capstone of the optimize loop (E6 Task 5).
   * This is the ONLY path in the codebase that turns a disposable
   * `PromptCandidate` into a real version; nothing promotes automatically.
   * Reuses `VersionsService.commitVersion` and `AliasesService.promoteAlias`
   * verbatim — both already carry their own audit trail
   * (`version_committed`, `alias_promoted` audit events) and business rules
   * (next-version-number computation, alias upsert), so no version-creation
   * or alias-moving logic is duplicated here.
   *
   * @param teamId - Isolation boundary.
   * @param userId - The acting user's id — stored as the new version's
   *   `createdBy` and as the audit actor for both reused calls.
   * @param runId - The optimize run the candidate must have been drafted
   *   for (from the URL) — scopes the candidate lookup so a candidate
   *   drafted for a different run (even in the same team) cannot be
   *   promoted through this run's endpoint.
   * @param dto - Validated body: which candidate to promote, and which
   *   alias to move (defaults to `'production'`).
   * @returns The newly committed version and the alias's new state.
   * @throws {NotFoundError} If the run does not exist for this team, or the
   *   candidate does not exist, belongs to another team, or was drafted for
   *   a different run than `runId`.
   */
  async promoteCandidate(
    teamId: string,
    userId: string,
    runId: string,
    dto: PromoteCandidateDto,
  ): Promise<PromoteCandidateResult> {
    const run = await this.runsRepo.getRunById(teamId, runId);
    if (!run) throw new NotFoundError('Run not found.');

    const candidate = await this.optimizeRepo.getCandidateForRun(teamId, runId, dto.prompt_candidate_id);
    if (!candidate) throw new NotFoundError('Prompt candidate not found for this run.');

    const { version } = await this.versionsService.commitVersion(candidate.promptId, teamId, userId, {
      messages: candidate.messages as unknown as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    });

    const alias = await this.aliasesService.promoteAlias(
      candidate.promptId,
      teamId,
      userId,
      dto.alias ?? 'production',
      { version_number: version.versionNumber },
    );

    return { version, alias };
  }

  /**
   * Reads one optimizer-drafted candidate's content — the read side of the
   * promote flow (E7 Task 5). A promote-review UI needs to show WHAT is
   * about to become a real version (its `messages` template + the
   * optimizer's `rationale`) before a human confirms the irreversible
   * {@link promoteCandidate} action; nothing before this endpoint exposed a
   * candidate's own template outside the queue-internal `cell.processor.ts`
   * read path. Read-only, so unlike {@link promoteCandidate} it does not
   * require promote-right — any team member who can view a run's report can
   * view what a candidate cell would promote to.
   *
   * @param teamId - Isolation boundary.
   * @param runId - The optimize run the candidate must have been drafted
   *   for (from the URL) — same run-scoping {@link promoteCandidate} uses,
   *   so a candidate id from a different run (even in the same team)
   *   resolves to nothing.
   * @param candidateId - `prompt_candidates` row UUID.
   * @returns The candidate's id, owning prompt, template, rationale, label, and creation time.
   * @throws {NotFoundError} If the run does not exist for this team, or the
   *   candidate does not exist, belongs to another team, or was drafted for
   *   a different run than `runId`.
   */
  async getCandidate(teamId: string, runId: string, candidateId: string): Promise<CandidateDetail> {
    const run = await this.runsRepo.getRunById(teamId, runId);
    if (!run) throw new NotFoundError('Run not found.');

    const candidate = await this.optimizeRepo.getCandidateForRun(teamId, runId, candidateId);
    if (!candidate) throw new NotFoundError('Prompt candidate not found for this run.');

    return {
      id: candidate.id,
      promptId: candidate.promptId,
      messages: candidate.messages as unknown as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      rationale: candidate.rationale,
      label: candidate.label,
      createdAt: candidate.createdAt,
    };
  }
}
