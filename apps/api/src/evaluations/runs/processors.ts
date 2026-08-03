/**
 * Narrow entry point for out-of-process job consumers (currently
 * `apps/worker`). Exposes ONLY the pieces a BullMQ worker process needs to
 * execute eval jobs and record terminal failures: `processCell`,
 * `processFinalize`, `processJudge`, `processOptimize`,
 * `markFinalizeExhausted`, and `RunsRepository` (used by the worker's
 * `'failed'` handlers to call `writeResultError`/`writeVerdict`).
 *
 * Deliberately does NOT re-export `RunsService`, `RunsController`,
 * `runsRouter`, or `./runs.types` the way `./index.ts` does — those pull in
 * Express (`runsRouter`/`RunsController`) and, transitively, its whole
 * `express/lib/**` graph. A worker process has no HTTP surface and must not
 * carry that dependency weight just to import two functions and a
 * repository. `processOptimize` itself pulls in `OptimizeRepository`/
 * `compileOptimizePrompt`/`parseCandidates` directly from their own files
 * (not the `../optimize` barrel, which also re-exports `OptimizeController`/
 * `optimizeRouter` and would pull Express in transitively) for the same
 * reason. See `apps/api/package.json`'s `exports` map: this file backs the
 * `./evaluations/runs/processors` subpath, kept alongside (not instead of)
 * the existing `./evaluations/runs` subpath that `./index.ts` backs, which
 * other/future HTTP-facing consumers may still need.
 */
export { RunsRepository } from './runs.repository';
export type { ExperimentRunWithResults } from './runs.repository';
export { processCell } from './cell.processor';
export { processFinalize, markFinalizeExhausted } from './finalize.processor';
export { processJudge } from './judge.processor';
export { processOptimize } from './optimize.processor';
