import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { RunsRepository } from './runs.repository';
import { DatasetsRepository } from '../datasets/datasets.repository';
import { PromptsRepository } from '../../prompts/prompts.repository';
import { AliasesRepository } from '../../prompts/aliases/aliases.repository';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import { OptimizeRepository } from '../optimize/optimize.repository';
import { compileOptimizePrompt } from '../optimize/optimize.prompt';
import { parseCandidatesDetailed } from '../optimize/optimize.parse';
import { extractVariables } from '../../prompts/versions/nunjucks.utils';
import { GatewayService } from '../../gateway/completions/gateway.service';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import { ConnectionsRepository } from '../../gateway/connections/connections.repository';
import type { GatewayCallContext } from '../../gateway/completions/completions.types';
import { getFlowProducer, EVAL_CELLS_QUEUE, EVAL_RUNS_QUEUE, finalizeJobOpts, type OptimizeJobData, type CellJobData } from '../queue';
import { NotFoundError } from '../../shared/errors';
import type { RunGridCell, RunSnapshotExample } from './runs.types';

/**
 * The optimizer LLM, overridable per deployment. Defaults to the same model
 * `JUDGE_MODEL` uses (`judge.service.ts`) — cheap enough to run once per
 * optimize attempt, capable enough to rewrite a template meaningfully.
 */
const OPTIMIZER_MODEL = process.env.EVAL_OPTIMIZER_MODEL ?? 'gpt-4o-mini';

const runsRepo = new RunsRepository();
const datasetsRepo = new DatasetsRepository();
const promptsRepo = new PromptsRepository();
const aliasesRepo = new AliasesRepository();
const versionsRepo = new VersionsRepository();
const optimizeRepo = new OptimizeRepository();
// Same construction as cell.processor.ts/judge.service.ts's module-level
// instance — the optimizer's own gateway call goes through the identical DI
// wiring (budgets/cache/cost ledger) as any other in-process caller, so
// drafting candidates is never a bypass of team spend caps or rate limits.
const gateway = new GatewayService(new GatewayRepository(), new ConnectionsRepository());

/** `A`, `B`, `C`, ... — used to mint `candidate-A`, `candidate-B`, ... labels. */
function candidateLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** How many times the optimizer's single gateway call is attempted (default 3). */
const OPTIMIZE_CALL_ATTEMPTS = Number(process.env.EVAL_OPTIMIZE_CALL_ATTEMPTS ?? 3);

/**
 * Runs `fn`, retrying up to `attempts` times with exponential backoff. Used
 * ONLY for the optimizer's single gateway call: `processOptimize` is not
 * idempotent (a whole-job retry after candidates were persisted would create
 * duplicates), so the flaky-provider retry FAQ Q13 wants is applied narrowly
 * to the one call that precedes any DB write, rather than via BullMQ job
 * attempts. Rethrows the last error once attempts are exhausted so the
 * optimize worker's `'failed'` handler still marks the run `failed`.
 *
 * @param fn - The async operation to attempt.
 * @param attempts - Max attempts (>=1); each retry waits `1s * 2^(n-1)`.
 * @returns Whatever `fn` resolves to.
 */
async function retryGatewayCall<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Executes one optimize job: the second half of the optimize flow, after
 * `OptimizeService.startOptimize` has already created the `queued` run (with
 * its example snapshot frozen) and returned 202 to the caller.
 *
 * Unlike `processCell` (one gateway call per grid cell), this function makes
 * exactly one gateway call — the optimizer itself — then, only once that
 * returns, resolves the grid and enqueues the SAME cell/finalize BullMQ Flow
 * `RunsService.startRun` builds for a normal run. This two-phase split
 * (`startOptimize` synchronous, `processOptimize` async) exists because the
 * grid cannot be known until the optimizer's candidates exist — `startRun`,
 * by contrast, can resolve its whole grid synchronously since every version
 * id it needs already exists before the HTTP request.
 *
 * Steps:
 * 1. Load the run's frozen `exampleSnapshot` and the dataset's `overallFeedback`.
 * 2. Resolve the prompt's current `production` alias + that version's `messages`.
 * 3. Compile the optimizer prompt (`compileOptimizePrompt`) from the
 *    production template + the snapshot's cases (no `priorOutput` — this is a
 *    brand-new optimize attempt, so there is no prior cell result to cite)
 *    and the dataset's `overallFeedback`, then call the optimizer model
 *    through the gateway (traced + budget-enforced, same pattern as
 *    `cell.processor.ts`/`JudgeService.scoreResult`).
 * 4. Parse the response (`parseCandidatesDetailed`, capped/dropped per Task 2's
 *    rules). If nothing survives, mark the run `failed` and stop — recording
 *    which candidates were dropped and why, so a shape problem in the
 *    optimizer's own output is distinguishable from a useless model.
 * 5. Otherwise persist each surviving candidate (`candidate-A`, `candidate-B`,
 *    ...), resolve the grid — one cell per (candidate x model) plus one cell
 *    per model for the production baseline — overwrite the run's `grid`, and
 *    enqueue the cell/finalize Flow (one finalize parent, one cell child per
 *    grid cell x snapshot example — identical shape/opts to `startRun`).
 *
 * @param data - The optimize job payload (`OptimizeJobData`).
 * @throws {NotFoundError} If the run, the dataset, the prompt itself, the
 *   prompt's `production` alias, or that alias's version cannot be found for
 *   `data.teamId`.
 * @throws Rethrows whatever `GatewayService.complete` throws (e.g. a
 *   budget/rate-limit error) unchanged — the optimizer call is never allowed
 *   to bypass budgets/rate limits, mirroring `processCell`/`JudgeService`.
 */
export async function processOptimize(data: OptimizeJobData): Promise<void> {
  const run = await runsRepo.getRunById(data.teamId, data.runId);
  if (!run) {
    throw new NotFoundError(`Experiment run ${data.runId} not found`);
  }
  const exampleSnapshot = run.exampleSnapshot as unknown as RunSnapshotExample[];

  const dataset = await datasetsRepo.getDatasetById(data.teamId, data.datasetId);
  if (!dataset) {
    throw new NotFoundError(`Dataset ${data.datasetId} not found`);
  }

  // Team-scoped ownership check, same defense-in-depth pattern as
  // RunsService.resolveGrid: OptimizeService.startOptimize already verifies
  // data.promptId belongs to data.teamId before this job is ever enqueued, so
  // this is a no-op on every current call path. It exists so that a future
  // change elsewhere (e.g. to AliasesRepository or to startOptimize) can't
  // silently reopen a cross-tenant read here -- AliasesRepository.findByAlias
  // itself takes no teamId and will resolve an alias for ANY promptId.
  const prompt = await promptsRepo.findById(data.promptId, data.teamId);
  if (!prompt) {
    throw new NotFoundError(`Prompt ${data.promptId} not found`);
  }

  const production = await aliasesRepo.findByAlias(data.promptId, 'production');
  if (!production) {
    throw new NotFoundError(`Production alias not found for prompt ${data.promptId}`);
  }

  // Team-scoped lookup, same reasoning as cell.processor.ts: never trust a
  // version id without re-verifying it belongs to data.teamId first.
  const productionVersion = await versionsRepo.findByIdForTeam(production.versionId, data.teamId);
  if (!productionVersion) {
    throw new NotFoundError(`Prompt version ${production.versionId} not found`);
  }

  const optimizerMessages = compileOptimizePrompt({
    productionMessages: productionVersion.messages,
    // No `priorOutput`: this is a brand-new optimize attempt, so there is no
    // earlier cell result for these examples to cite yet.
    cases: exampleSnapshot.map((example) => ({ input: example.input, criteria: example.criteria })),
    overallFeedback: dataset.overallFeedback,
    draftCount: data.draftCount,
  });

  // Minted up front, same reasoning as cell.processor.ts/judge.service.ts:
  // GatewayResult does not carry the trace id it produced, but a
  // caller-supplied ctx.traceId becomes the new trace's row PK when no trace
  // with that id exists yet, so generating it here is sufficient to know the
  // resulting trace id without a lookup.
  const traceId = randomUUID();
  const ctx: GatewayCallContext = { teamId: data.teamId, traceId };
  // Retry the optimizer's one gateway call on a transient failure (429/5xx)
  // before any candidate is persisted — see `retryGatewayCall` for why this is
  // in-function rather than a BullMQ job retry.
  const gatewayResult = await retryGatewayCall(
    () => gateway.complete(ctx, { model: OPTIMIZER_MODEL, messages: optimizerMessages }),
    OPTIMIZE_CALL_ATTEMPTS,
  );
  const assistantContent = gatewayResult.body.choices[0]?.message.content ?? '';

  // Finding #17: a rewrite that silently drops or invents a `{{ variable }}`
  // is otherwise indistinguishable from a valid one (both parse fine) — pass
  // the production template's own variable set so parseCandidates can drop
  // any candidate whose set doesn't match it exactly.
  const originalVariables = extractVariables(productionVersion.messages as unknown as Array<{ content: string }>);
  const { candidates, rejections } = parseCandidatesDetailed(
    assistantContent,
    data.draftCount,
    originalVariables,
  );

  if (candidates.length === 0) {
    // Say which way it failed. The generic message hid the case where the
    // optimizer returned perfectly good rewrites that were all dropped on a
    // variable-set mismatch, which reads as "the model was useless" when it was
    // really a shape problem worth fixing.
    await runsRepo.setRunStatus(data.runId, 'failed', {
      error:
        rejections.length > 0
          ? `optimizer produced no valid candidates — ${rejections.join(' | ')}`
          : 'optimizer produced no valid candidates',
      endedAt: new Date(),
    });
    return;
  }

  const createdCandidates: Array<{ id: string; label: string }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const label = `candidate-${candidateLetter(i)}`;
    const created = await optimizeRepo.createCandidate({
      teamId: data.teamId,
      promptId: data.promptId,
      experimentRunId: data.runId,
      messages: candidate.messages as unknown as Prisma.InputJsonValue,
      rationale: candidate.rationale,
      label,
      createdBy: data.userId,
    });
    createdCandidates.push({ id: created.id, label });
  }

  const grid: RunGridCell[] = [];
  for (const candidate of createdCandidates) {
    for (const model of data.models) {
      grid.push({
        cellKey: `${candidate.label}|${model}`,
        variantKind: 'candidate',
        promptCandidateId: candidate.id,
        variantLabel: candidate.label,
        model,
        isProductionBaseline: false,
      });
    }
  }
  for (const model of data.models) {
    grid.push({
      cellKey: `production|${model}`,
      variantKind: 'version',
      promptVersionId: production.versionId,
      variantLabel: 'production',
      model,
      isProductionBaseline: true,
    });
  }

  await runsRepo.setRunGrid(data.runId, grid as unknown as Prisma.InputJsonValue);

  // How many times each cell (one gateway call) is attempted before it is
  // recorded as a terminal error — same knob/default as `RunsService.startRun`.
  const cellAttempts = Number(process.env.EVAL_CELL_JOB_ATTEMPTS ?? 3);

  await getFlowProducer().add({
    name: 'finalize',
    queueName: EVAL_RUNS_QUEUE,
    data: { teamId: data.teamId, runId: data.runId },
    // Same size-scaled finalize budget as `RunsService.startRun` — see
    // `finalizeJobOpts` for the rationale (judge jobs settle out-of-band).
    opts: finalizeJobOpts(grid.length * exampleSnapshot.length),
    children: grid.flatMap((cell) =>
      exampleSnapshot.map((example) => {
        const cellData: CellJobData = {
          teamId: data.teamId,
          runId: data.runId,
          cellKey: cell.cellKey,
          variantLabel: cell.variantLabel,
          variantKind: cell.variantKind,
          model: cell.model,
          exampleId: example.exampleId,
          // Freeze the dataset directive onto the cell job (→ judge job), so
          // the judge grades against the run's frozen value, not the live
          // dataset (FAQ Q5 reproducibility) — same as `RunsService.startRun`.
          overallFeedback: dataset.overallFeedback,
          ...(cell.promptVersionId ? { promptVersionId: cell.promptVersionId } : {}),
          ...(cell.promptCandidateId ? { promptCandidateId: cell.promptCandidateId } : {}),
        };
        return {
          name: 'cell',
          queueName: EVAL_CELLS_QUEUE,
          data: cellData,
          // Same failure policy as `RunsService.startRun`'s children — see
          // that method's comment: retries-with-backoff for flaky provider
          // calls, and `ignoreDependencyOnFailure` so a permanently-failed
          // cell does not leave the finalize parent stuck forever.
          opts: {
            attempts: cellAttempts,
            backoff: { type: 'exponential', delay: 1000 },
            ignoreDependencyOnFailure: true,
          },
        };
      }),
    ),
  });
}
