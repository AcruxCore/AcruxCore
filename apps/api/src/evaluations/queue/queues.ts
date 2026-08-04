import { Queue, FlowProducer } from 'bullmq';
import { getRedisConnection } from './connection';

/**
 * Queue name for evaluating individual experiment cells.
 */
export const EVAL_CELLS_QUEUE = 'eval-cells';

/**
 * Queue name for finalizing experiment runs after all cells complete.
 */
export const EVAL_RUNS_QUEUE = 'eval-runs';

/**
 * Queue name for LLM-as-judge scoring of individual produced `eval_result` rows.
 */
export const EVAL_JUDGE_QUEUE = 'eval-judge';

/**
 * Queue name for optimizer draft jobs (E6): draft candidate rewrites, persist
 * the surviving ones, resolve the (candidate + production) x model grid, and
 * enqueue the same cell/finalize Flow `EVAL_CELLS_QUEUE`/`EVAL_RUNS_QUEUE`
 * already use for a normal run.
 */
export const EVAL_OPTIMIZE_QUEUE = 'eval-optimize';

/**
 * Data payload for a cell evaluation job.
 * Contains all information needed to execute a single cell's LLM invocation.
 * Exactly one of `promptVersionId`/`promptCandidateId` is set: a `'version'`
 * cell (an explicit version or the production baseline) carries
 * `promptVersionId`; a `'candidate'` cell (E6 — an optimizer-drafted rewrite,
 * not yet a real prompt version) carries `promptCandidateId` instead, and
 * `cell.processor.ts` renders its template from `prompt_candidates.messages`.
 */
export interface CellJobData {
  /** Team ID for tenant isolation. */
  teamId: string;
  /** Experiment run ID this cell belongs to. */
  runId: string;
  /** Unique key identifying this cell within the run. */
  cellKey: string;
  /** ID of the prompt version to use for this cell. Unset for a `'candidate'` cell. */
  promptVersionId?: string;
  /** ID of the optimizer-drafted candidate to use for this cell (E6). Unset for a `'version'` cell. */
  promptCandidateId?: string;
  /** Human-readable label for the model/variant. */
  variantLabel: string;
  /** Type of variant (e.g. "version", "candidate"). */
  variantKind: string;
  /** LLM model identifier. */
  model: string;
  /** ID of the example/input to evaluate against. */
  exampleId: string;
  /**
   * The dataset-level `overallFeedback`, FROZEN at run-start (from
   * `dataset.overallFeedback`) so the judge grades against the run's snapshot
   * rather than the live, mutable dataset (FAQ Q5 reproducibility). Forwarded
   * verbatim by `cell.processor` into the judge job. Undefined on jobs enqueued
   * before this field shipped — the judge falls back to a live read in that case.
   */
  overallFeedback?: string | null;
}

/**
 * Data payload for a run finalization job.
 * Triggered after all cell evaluations in a run complete.
 */
export interface FinalizeJobData {
  /** Team ID for tenant isolation. */
  teamId: string;
  /** Experiment run ID to finalize. */
  runId: string;
}

/**
 * Data payload for a judge scoring job.
 * Enqueued by `cell.processor.ts` right after a cell's `eval_result` row is
 * written, so `JudgeService.scoreResult` can grade it out-of-band.
 */
export interface JudgeJobData {
  /** Team ID for tenant isolation. */
  teamId: string;
  /** ID of the `eval_result` row to score. */
  resultId: string;
  /**
   * The per-example `criteria`, FROZEN into the run's `exampleSnapshot` at
   * run-start and forwarded here by `cell.processor` — so the judge grades
   * against what the run captured, not the live (mutable) dataset example
   * (FAQ Q5 reproducibility). Undefined on jobs enqueued before this field
   * shipped; the judge then falls back to reading the example's live `criteria`.
   */
  criteria?: string | null;
  /**
   * The example's frozen `history` (FAQ Q19), forwarded here by
   * `cell.processor` so the judge can grade with the same conversational
   * context the model under test saw. Undefined on jobs enqueued before this
   * field shipped.
   */
  history?: import('../../gateway/providers/types').ChatMessage[] | null;
  /**
   * The dataset-level `overallFeedback`, FROZEN at run-start and forwarded here
   * by `cell.processor` (same reasoning as {@link JudgeJobData.criteria}).
   * Undefined on pre-existing jobs → judge falls back to a live read.
   */
  overallFeedback?: string | null;
}

/**
 * Data payload for an optimize job (E6). Enqueued by `OptimizeService.startOptimize`
 * right after the `queued` run + example snapshot are persisted; consumed by
 * `processOptimize` (`apps/api/src/evaluations/runs/optimize.processor.ts`),
 * which drafts candidates, resolves the grid, and enqueues the cell/finalize
 * Flow itself — this job is NOT a Flow parent/child, it runs standalone
 * before the grid (and therefore the Flow) can even be built.
 */
export interface OptimizeJobData {
  /** Team ID for tenant isolation. */
  teamId: string;
  /** Acting user id (nullable for team-scoped API key callers); becomes each candidate's `createdBy`. */
  userId: string | null;
  /** Prompt whose production version is being optimized. */
  promptId: string;
  /** The experiment created to hold this optimize attempt's run. */
  experimentId: string;
  /** The `queued` run created by `startOptimize`, already carrying the frozen example snapshot. */
  runId: string;
  /** Dataset the failing cases are drawn from. */
  datasetId: string;
  /** Models to run each candidate + the production baseline against. */
  models: string[];
  /**
   * Alias whose version is the comparison baseline, or undefined to use the
   * prompt's latest committed version (design "Alias-based baseline").
   */
  alias?: string;
  /** Max number of candidate rewrites to request/keep. */
  draftCount: number;
}

/**
 * Builds the BullMQ opts for a run's finalize (Flow-parent) job, sizing its
 * retry budget to the run.
 *
 * The finalize job is NOT a Flow parent of the per-cell judge jobs (those are
 * enqueued independently by `cell.processor` after each result is written), so
 * it becomes eligible as soon as all cell children settle — before judging has
 * necessarily finished. `processFinalize` throws while any produced result is
 * still unjudged, relying on BullMQ retries to poll until judging catches up.
 *
 * A FIXED 3s poll with attempts scaled to the cell/judge count (`numCellJobs`)
 * gives a budget that grows ~linearly with run size: `min(400, max(20, n+10))`
 * attempts → roughly 60s for a tiny run up to ~20min for a very large one. This
 * replaces the previous fixed `10 × exponential(1s)` (~8.5min total regardless
 * of size), under which a large-but-healthy run could exhaust the budget while
 * judging was still legitimately draining and be marked terminally `failed`.
 * Once the budget is genuinely exhausted (e.g. a permanent judge/gateway
 * outage), `apps/worker`'s `runWorker.on('failed')` transitions the run to
 * `failed` rather than leaving it stuck at `queued` forever.
 *
 * @param numCellJobs - Total cell jobs in the run (`grid × examples`); the
 *   upper bound on how many judge jobs must settle before finalize can succeed.
 * @returns BullMQ `JobsOptions` for the finalize job.
 */
export function finalizeJobOpts(numCellJobs: number): { attempts: number; backoff: { type: 'fixed'; delay: number } } {
  return {
    attempts: Math.min(400, Math.max(20, numCellJobs + 10)),
    backoff: { type: 'fixed', delay: 3000 },
  };
}

let flowProducer: FlowProducer | null = null;

/**
 * Get a memoized BullMQ FlowProducer for orchestrating job workflows.
 *
 * @returns A singleton FlowProducer connected to the shared Redis instance.
 */
export function getFlowProducer(): FlowProducer {
  if (!flowProducer) {
    flowProducer = new FlowProducer({
      connection: getRedisConnection(),
    });
  }
  return flowProducer;
}

let cellsQueue: Queue<CellJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for cell evaluation jobs.
 *
 * @returns A singleton Queue<CellJobData> for processing individual cell evaluations.
 */
export function getCellsQueue(): Queue<CellJobData> {
  if (!cellsQueue) {
    cellsQueue = new Queue<CellJobData>(EVAL_CELLS_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return cellsQueue;
}

let runsQueue: Queue<FinalizeJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for run finalization jobs.
 *
 * @returns A singleton Queue<FinalizeJobData> for processing run finalizations.
 */
export function getRunsQueue(): Queue<FinalizeJobData> {
  if (!runsQueue) {
    runsQueue = new Queue<FinalizeJobData>(EVAL_RUNS_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return runsQueue;
}

let judgeQueue: Queue<JudgeJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for judge scoring jobs.
 *
 * @returns A singleton Queue<JudgeJobData> for processing per-result judge scoring.
 */
export function getJudgeQueue(): Queue<JudgeJobData> {
  if (!judgeQueue) {
    judgeQueue = new Queue<JudgeJobData>(EVAL_JUDGE_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return judgeQueue;
}

let optimizeQueue: Queue<OptimizeJobData> | null = null;

/**
 * Get a memoized BullMQ Queue for optimize draft jobs.
 *
 * @returns A singleton Queue<OptimizeJobData> for processing optimizer draft jobs.
 */
export function getOptimizeQueue(): Queue<OptimizeJobData> {
  if (!optimizeQueue) {
    optimizeQueue = new Queue<OptimizeJobData>(EVAL_OPTIMIZE_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return optimizeQueue;
}
