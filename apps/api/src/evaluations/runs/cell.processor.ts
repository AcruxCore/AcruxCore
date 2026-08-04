import { randomUUID } from 'node:crypto';
import { getJudgeQueue, type CellJobData } from '../queue';
import { RunsRepository } from './runs.repository';
import { VersionsRepository } from '../../prompts/versions/versions.repository';
import { OptimizeRepository } from '../optimize/optimize.repository';
import { renderMessages } from '../../prompts/versions/nunjucks.utils';
import type { MessageInput, RenderedMessage } from '../../prompts/versions/nunjucks.utils';
import { sanitizeForReplay } from '../datasets/history.builder';
import { GatewayService } from '../../gateway/completions/gateway.service';
import { GatewayRepository } from '../../gateway/completions/gateway.repository';
import { ConnectionsRepository } from '../../gateway/connections/connections.repository';
import type { GatewayCallContext } from '../../gateway/completions/completions.types';
import type { ChatMessage } from '../../gateway/providers/types';
import { NotFoundError } from '../../shared/errors';

const runsRepo = new RunsRepository();
const versionsRepo = new VersionsRepository();
const optimizeRepo = new OptimizeRepository();
// Same construction as gateway.router.ts's module-level instance — reused here
// so eval calls go through the identical DI wiring (budgets/cache/cost ledger).
const gateway = new GatewayService(new GatewayRepository(), new ConnectionsRepository());

/** One frozen example inside `ExperimentRun.exampleSnapshot` (design §"Data model"). */
interface SnapshotExample {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  /** Prior-turn history frozen at run-start (FAQ Q19), or null. */
  history: ChatMessage[] | null;
}

/**
 * Splices a reconstructed session history in before a rendered template's
 * new turn: any leading `system` message(s) from `rendered` come first (a
 * version's system prompt must not repeat once per turn), then `history`,
 * then the rest of `rendered` (the new turn). Returns `rendered` unchanged,
 * cast to `ChatMessage[]`, when `history` is null/empty — a cell with no
 * history sends exactly what it sends today.
 *
 * The history is run through `sanitizeForReplay` first. Build-time already
 * does this, but a hand-authored `history` never passed through it and neither
 * did rows frozen into a snapshot before it existed, and this is the one place
 * where a half tool round trip stops being data and becomes a provider 400
 * that fails the cell.
 *
 * @param rendered - The template's rendered messages for this cell's new turn.
 * @param history - The frozen prior-turn history, or null.
 * @returns The final message array to send to the gateway.
 */
function spliceHistory(rendered: RenderedMessage[], history: ChatMessage[] | null | undefined): ChatMessage[] {
  const replayable = history ? sanitizeForReplay(history) : [];
  if (replayable.length === 0) return rendered as ChatMessage[];

  const leadingSystemCount = rendered.findIndex((m) => m.role !== 'system');
  const splitAt = leadingSystemCount === -1 ? rendered.length : leadingSystemCount;
  const leadingSystem = rendered.slice(0, splitAt) as ChatMessage[];
  const rest = rendered.slice(splitAt) as ChatMessage[];
  return [...leadingSystem, ...replayable, ...rest];
}

/**
 * Resolves the message template a cell job should render, dispatching on
 * `data.variantKind` (E6 Task 4): a `'candidate'` cell renders from
 * `prompt_candidates.messages` (an optimizer-drafted rewrite, never promoted
 * to a real `PromptVersion`); any other cell (`'version'` — an explicit
 * version or the production baseline) renders from `PromptVersion.messages`
 * as before. Both lookups are team-scoped so a queue payload can never read
 * another team's template.
 *
 * @param data - The cell job payload.
 * @returns The unrendered OpenAI-shaped message template.
 * @throws {NotFoundError} If the discriminated id (`promptCandidateId` or
 *   `promptVersionId`) is missing, or the row it names does not exist or
 *   belongs to a different team than `data.teamId`.
 */
async function resolveCellMessages(data: CellJobData): Promise<MessageInput[]> {
  if (data.variantKind === 'candidate') {
    if (!data.promptCandidateId) {
      throw new NotFoundError(`Cell ${data.cellKey} is variantKind 'candidate' but carries no promptCandidateId`);
    }
    // Team-scoped lookup, same reasoning as the version branch below:
    // promptCandidateId arrives from a queue payload, so it must be verified
    // as belonging to data.teamId before its content is rendered and sent
    // through the gateway under this team's budget.
    const candidate = await optimizeRepo.getCandidateById(data.teamId, data.promptCandidateId);
    if (!candidate) {
      throw new NotFoundError(`Prompt candidate ${data.promptCandidateId} not found`);
    }
    return candidate.messages as unknown as MessageInput[];
  }

  if (!data.promptVersionId) {
    throw new NotFoundError(`Cell ${data.cellKey} is variantKind '${data.variantKind}' but carries no promptVersionId`);
  }

  // Team-scoped lookup (not versionsRepo.findById, which is a global by-id
  // query): promptVersionId arrives from a queue payload, so it must be
  // verified as belonging to data.teamId before its content is rendered and
  // sent through the gateway under this team's budget — a cross-team id is
  // treated identically to "doesn't exist for this team" (established
  // pattern used by datasets/experiments repositories).
  const version = await versionsRepo.findByIdForTeam(data.promptVersionId, data.teamId);
  if (!version) {
    throw new NotFoundError(`Prompt version ${data.promptVersionId} not found`);
  }
  return version.messages as unknown as MessageInput[];
}

/**
 * Executes one eval cell: renders the cell's message template (a
 * `PromptVersion`'s for a `'version'` cell, or a `PromptCandidate`'s for a
 * `'candidate'` cell drafted by the optimizer — E6 Task 4) with the frozen
 * example's `input` variables, calls the gateway in-process (so budgets, rate
 * limits, and the cost ledger apply exactly like live traffic — FAQ Q1/Q16),
 * and records the produced output + originating trace.
 *
 * The gateway call context is minted with a fresh `traceId` up front. This is
 * necessary because `GatewayResult` does not carry the trace id it produced
 * (only `requestId`, the `gateway_requests` row id) — but the trace-recording
 * hook (`recordGatewaySpan`) honors a caller-supplied `ctx.traceId` as the new
 * trace's primary key when no trace with that id exists yet (the same
 * "caller-supplied traceId becomes the row PK when absent" contract used by
 * the SDK trace-ingestion endpoint), so generating it here and threading it
 * through is sufficient to know the resulting trace id without a lookup.
 *
 * After the produced `eval_result` row is written, enqueues a judge job
 * (`EVAL_JUDGE_QUEUE`, Task 4) carrying the new row's id so `JudgeService`
 * scores it out-of-band — this function itself never calls the judge model.
 *

 * @param data - The cell job payload (`CellJobData`, Task 2): identifies the
 *   run, the example, the prompt version or candidate, and the model for
 *   this one cell.
 * @throws {NotFoundError} If the run, its snapshot entry for `data.exampleId`,
 *   or the prompt version/candidate cannot be found — including when it
 *   exists but belongs to a different team than `data.teamId` (treated
 *   identically to "doesn't exist" to prevent cross-tenant reads).
 * @throws Rethrows any error from `renderMessages` or `GatewayService.complete`
 *   unchanged so BullMQ retries the job. Terminal-failure recording
 *   (`writeResultError`) is the worker's failed-job handler's job (Task 6),
 *   not this function's — it must never swallow an error itself.
 */
export async function processCell(data: CellJobData): Promise<void> {
  const run = await runsRepo.getRunById(data.teamId, data.runId);
  if (!run) {
    throw new NotFoundError(`Experiment run ${data.runId} not found`);
  }

  // First cell to reach here flips the run queued → running and stamps
  // startedAt; every later cell is a no-op (markRunning guards on
  // status: 'queued'). Done before any gateway work so the run reflects
  // "running" as soon as real execution begins, not only once it finalizes.
  await runsRepo.markRunning(data.runId);

  const snapshot = run.exampleSnapshot as unknown as SnapshotExample[];
  const example = snapshot.find((e) => e.exampleId === data.exampleId);
  if (!example) {
    throw new NotFoundError(`Example ${data.exampleId} not found in run ${data.runId}'s snapshot`);
  }

  const messages = await resolveCellMessages(data);
  const rendered = await renderMessages(messages, example.input);
  const finalMessages = spliceHistory(rendered, example.history);

  const traceId = randomUUID();
  const ctx: GatewayCallContext = { teamId: data.teamId, traceId };

  const gatewayResult = await gateway.complete(ctx, { model: data.model, messages: finalMessages });
  const output = gatewayResult.body.choices[0]?.message.content ?? '';

  const result = await runsRepo.writeResult({
    teamId: data.teamId,
    experimentRunId: data.runId,
    datasetExampleId: data.exampleId,
    variantKind: data.variantKind,
    ...(data.variantKind === 'candidate'
      ? { promptCandidateId: data.promptCandidateId }
      : { promptVersionId: data.promptVersionId }),
    variantLabel: data.variantLabel,
    model: data.model,
    output,
    traceId,
  });

  await getJudgeQueue().add(
    'judge',
    {
      teamId: data.teamId,
      resultId: result.id,
      // Freeze the grading inputs into the judge job: the per-example
      // `criteria` from this run's snapshot, and the run-level `overallFeedback`
      // frozen onto the cell job at run-start. The judge grades against these
      // instead of re-reading the live (mutable) dataset, so editing a
      // criterion or the overall feedback mid-run — or after it — can no longer
      // change what a given result was scored against (FAQ Q5 reproducibility).
      criteria: example.criteria,
      history: example.history,
      overallFeedback: data.overallFeedback ?? null,
    },
    {
      // Retries-with-backoff for the judge's own (flaky) gateway call — the same
      // rationale, and same default, as the cell job's `EVAL_CELL_JOB_ATTEMPTS`
      // (FAQ Q13). Without this the judge got a single attempt: one transient
      // 429/5xx permanently lost a cell's score (the worker's `'failed'` handler
      // wrote a terminal "judge call failed" marker on the first failure).
      // `JudgeService.scoreResult` rethrows gateway errors, so BullMQ retries them.
      attempts: Number(process.env.EVAL_JUDGE_JOB_ATTEMPTS ?? 3),
      backoff: { type: 'exponential', delay: 1000 },
    },
  );
}
