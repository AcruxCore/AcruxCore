import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';

/**
 * Every id a request can carry in its body is accounted for.
 *
 * `cross-tenant.test.ts` walks the router tree, so it sees ids that arrive in a
 * URL. That is the shape most of this API uses, and the convention held for all
 * 88 of them. The three places it did not hold were the other shape: an id in the
 * request BODY, which no route-level check ever sees.
 *
 *   - `POST /gateway/budgets` took another team's `virtualKeyId`.
 *   - `POST /traces` took another team's `promptVersionId` per span.
 *   - `POST /experiments` took another team's `prompt_id` and `version_ids`.
 *
 * A body field cannot be probed generically the way a route can — each one needs
 * a request the endpoint accepts. What this file does instead is refuse to let a
 * new one appear unnoticed: it walks every Zod schema in the API, collects every
 * field that is a UUID, and requires each to be listed below with what verifies
 * it. A schema gaining a `somethingId` next year fails this test on the day it is
 * added, and whoever adds it has to say which of the three kinds it is.
 *
 * This is the same trade the route matrix makes. It cannot prove a check is
 * correct; it can prove nobody forgot to think about one.
 */

/** What answers for a UUID field once a request carries it. */
type Verdict =
  /** A service looks the id up scoped to the caller's team before using it. */
  | 'ownership-checked'
  /** Compared against the caller's own rows only, so a foreign id matches nothing. */
  | 'filter-only'
  /** Not a reference to a stored object: an idempotency key, a client-minted id. */
  | 'not-an-object-ref';

/**
 * Every UUID field in every request schema, with what stands behind it.
 * Key is `<file>:<ExportedSchema>.<field path>`.
 */
const UUID_FIELDS: Record<string, { verdict: Verdict; by: string }> = {
  'audit/audit.types.ts:TeamAuditQuerySchema.actorId': {
    verdict: 'filter-only',
    by: 'teamAuditWhere() ANDs it into a query already scoped to the team.',
  },
  'auth/auth.types.ts:SwitchTeamSchema.teamId': {
    verdict: 'ownership-checked',
    by: 'AuthService.switchTeam → repo.isMember, 404 when the caller is not in it.',
  },

  'evaluations/datasets/datasets.types.ts:AddExamplesFromFeedbackSchema.feedback_ids[]': {
    verdict: 'ownership-checked',
    by: 'collectExamplesFromFeedback → findFeedbackByIds(teamId); anything else is reported skipped as "feedback not found".',
  },
  'evaluations/datasets/datasets.types.ts:BuildFromFeedbackSchema.feedback_ids[]': {
    verdict: 'ownership-checked',
    by: 'Same path as AddExamplesFromFeedback.',
  },
  'evaluations/datasets/datasets.types.ts:AddExamplesFromFeedbackSchema.filter.prompt_id': {
    verdict: 'filter-only',
    by: 'Narrows the team\u2019s own feedback rows; a foreign id matches none of them.',
  },
  'evaluations/datasets/datasets.types.ts:AddExamplesFromFeedbackSchema.filter.prompt_version_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'evaluations/datasets/datasets.types.ts:AddExamplesFromFeedbackSchema.filter.rule_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'evaluations/datasets/datasets.types.ts:BuildFromFeedbackSchema.filter.prompt_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'evaluations/datasets/datasets.types.ts:BuildFromFeedbackSchema.filter.prompt_version_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'evaluations/datasets/datasets.types.ts:BuildFromFeedbackSchema.filter.rule_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },

  'evaluations/experiments/experiments.types.ts:CreateExperimentSchema.dataset_id': {
    verdict: 'ownership-checked',
    by: 'ExperimentsService.create → datasetsRepo.getDatasetById(teamId), 404.',
  },
  'evaluations/experiments/experiments.types.ts:CreateExperimentSchema.prompt_id': {
    verdict: 'ownership-checked',
    by: 'ExperimentsService.create → prompts.findById(id, teamId), 404.',
  },
  'evaluations/experiments/experiments.types.ts:CreateExperimentSchema.version_ids[]': {
    verdict: 'ownership-checked',
    by: 'ExperimentsService.create → promptVersions.countByIdsForTeam, 404 unless every id is the team\u2019s.',
  },

  'evaluations/online/online-eval-rule.types.ts:CreateEvalRuleSchema.judgePromptId': {
    verdict: 'ownership-checked',
    by: 'assertJudgePromptExists → promptsRepo.findById(id, teamId).',
  },
  'evaluations/online/online-eval-rule.types.ts:UpdateEvalRuleSchema.judgePromptId': {
    verdict: 'ownership-checked',
    by: 'Same check on the update path.',
  },
  'evaluations/online/online-eval-rule.types.ts:CreateEvalRuleSchema.filter.promptId': {
    verdict: 'filter-only',
    by: 'matchesRule compares it with the span\u2019s own version; a foreign id matches nothing.',
  },
  'evaluations/online/online-eval-rule.types.ts:UpdateEvalRuleSchema.filter.promptId': {
    verdict: 'filter-only',
    by: 'The same comparison in matchesRule, reached through the update path.',
  },
  'evaluations/online/online-eval-rule.types.ts:EvalRuleFilterSchema.promptId': {
    verdict: 'filter-only',
    by: 'The shared filter shape behind both rule schemas; compared, never resolved.',
  },

  'evaluations/optimize/optimize.types.ts:StartOptimizeSchema.dataset_id': {
    verdict: 'ownership-checked',
    by: 'OptimizeService.start → datasetsRepo.getDatasetById(teamId).',
  },
  'evaluations/optimize/optimize.types.ts:StartOptimizeSchema.optimizer_prompt_id': {
    verdict: 'ownership-checked',
    by: 'OptimizeService.start → promptsRepo.findById(id, teamId).',
  },
  'evaluations/optimize/optimize.types.ts:PromoteCandidateSchema.prompt_candidate_id': {
    verdict: 'ownership-checked',
    by: 'optimizeRepo.getCandidateForRun(teamId, runId, id).',
  },

  'evaluations/runs/runs.types.ts:RunListQuerySchema.dataset_id': {
    verdict: 'filter-only',
    by: 'Narrows a run list already scoped to the team.',
  },
  'evaluations/runs/runs.types.ts:RunListQuerySchema.prompt_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },

  'gateway/budgets/budgets.types.ts:CreateBudgetSchema.virtualKeyId': {
    verdict: 'ownership-checked',
    by: 'BudgetsService.create → repo.virtualKeyBelongsToTeam, 404.',
  },
  'gateway/completions/completions.types.ts:ChatCompletionRequestSchema.prompt_version_id': {
    verdict: 'ownership-checked',
    by: 'resolveClientPromptVersionId → promptVersions.findByIdForTeam, 400.',
  },
  'gateway/completions/completions.types.ts:TraceContextBodySchema.traceId': {
    verdict: 'ownership-checked',
    by: 'writeGatewaySpan → spansRepo.findTrace(id, teamId); an id outside the team resolves to nothing.',
  },
  'gateway/models/models.types.ts:CreateModelSchema.credentialId': {
    verdict: 'ownership-checked',
    by: 'assertCredentialInTeam → connectionsRepo.findByIdForTeam.',
  },
  'gateway/models/models.types.ts:UpdateModelSchema.credentialId': {
    verdict: 'ownership-checked',
    by: 'Same check on the update path.',
  },
  'gateway/models/models.types.ts:CreateModelSchema.fallbackModelIds[]': {
    verdict: 'ownership-checked',
    by: 'assertValidFallbacks resolves every id within the team.',
  },
  'gateway/models/models.types.ts:UpdateModelSchema.fallbackModelIds[]': {
    verdict: 'ownership-checked',
    by: 'Same check on the update path.',
  },
  'gateway/usage/usage.types.ts:UsageQuerySchema.virtual_key_id': {
    verdict: 'filter-only',
    by: 'ANDed into a gateway_requests query already scoped by team_id.',
  },
  'gateway/usage/usage.types.ts:RequestListQuerySchema.virtual_key_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },

  'traces/feedback/feedback.types.ts:FeedbackFilterSchema.prompt_id': {
    verdict: 'filter-only',
    by: 'Narrows the team\u2019s own feedback rows.',
  },
  'traces/feedback/feedback.types.ts:FeedbackFilterSchema.prompt_version_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/feedback/feedback.types.ts:FeedbackFilterSchema.rule_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/feedback/feedback.types.ts:FeedbackListQuerySchema.prompt_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/feedback/feedback.types.ts:FeedbackListQuerySchema.prompt_version_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/feedback/feedback.types.ts:FeedbackListQuerySchema.rule_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/filters/filters.types.ts:TraceFilterQuerySchema.prompt_id': {
    verdict: 'filter-only',
    by: 'buildTraceConditions ANDs it into a trace query already scoped by team.',
  },
  'traces/filters/filters.types.ts:TraceFilterQuerySchema.prompt_version_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/filters/filters.types.ts:TraceFilterQuerySchema.rule_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/query/query.types.ts:TraceListQuerySchema.prompt_id': {
    verdict: 'filter-only',
    by: 'The same filter shape, on the trace list.',
  },
  'traces/query/query.types.ts:TraceListQuerySchema.prompt_version_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },
  'traces/query/query.types.ts:TraceListQuerySchema.rule_id': {
    verdict: 'filter-only',
    by: 'Narrows rows already scoped to the team; a foreign id matches none of them.',
  },

  'traces/ingest/ingest.types.ts:IngestBatchSchema.traces[].traceId': {
    verdict: 'ownership-checked',
    by: 'IngestService.ingestTrace → findTraceById then an explicit team comparison, 404.',
  },
  'traces/ingest/ingest.types.ts:IngestTraceSchema.traceId': {
    verdict: 'ownership-checked',
    by: 'The trace shape inside the batch above.',
  },
  'traces/ingest/ingest.types.ts:IngestBatchSchema.traces[].spans[].promptVersionId': {
    verdict: 'ownership-checked',
    by: 'IngestService.assertPromptVersionsAreOurs → findByIdForTeam, 404.',
  },
  'traces/ingest/ingest.types.ts:IngestTraceSchema.spans[].promptVersionId': {
    verdict: 'ownership-checked',
    by: 'The same field, reached through the trace shape.',
  },
  'traces/ingest/ingest.types.ts:IngestSpanSchema.promptVersionId': {
    verdict: 'ownership-checked',
    by: 'The same field, reached through the span shape.',
  },
};

/** Recursively lists every `.ts` file under a directory, skipping tests. */
function typeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...typeFiles(full));
    else if (entry.endsWith('.types.ts')) out.push(full);
  }
  return out;
}

/** True when a Zod string carries the `uuid` check. */
function isUuidString(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName?: string; checks?: Array<{ kind: string }> };
  return def.typeName === 'ZodString' && (def.checks ?? []).some((c) => c.kind === 'uuid');
}

/** Peels the wrappers that do not change what a field means. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema._def as Record<string, unknown>;
  const name = def.typeName as string;
  if (name === 'ZodOptional' || name === 'ZodNullable' || name === 'ZodDefault') {
    return unwrap(def.innerType as z.ZodTypeAny);
  }
  if (name === 'ZodEffects') return unwrap(def.schema as z.ZodTypeAny);
  return schema;
}

/** Collects the dotted paths of every UUID field inside one schema. */
function uuidPaths(schema: z.ZodTypeAny, prefix = '', depth = 0): string[] {
  if (depth > 6) return [];
  const inner = unwrap(schema);
  const def = inner._def as Record<string, unknown>;
  const name = def.typeName as string;

  if (isUuidString(inner)) return [prefix];
  if (name === 'ZodArray') return uuidPaths(def.type as z.ZodTypeAny, `${prefix}[]`, depth + 1);
  if (name === 'ZodObject') {
    const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
    return Object.entries(shape).flatMap(([key, value]) =>
      uuidPaths(value, prefix ? `${prefix}.${key}` : key, depth + 1),
    );
  }
  if (name === 'ZodUnion') {
    return (def.options as z.ZodTypeAny[]).flatMap((o) => uuidPaths(o, prefix, depth + 1));
  }
  return [];
}

describe('body-borne object references', () => {
  it('accounts for every UUID a request schema accepts', () => {
    const root = join(__dirname, '..', '..');
    const found = new Map<string, true>();

    for (const file of typeFiles(root)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(file) as Record<string, unknown>;
      for (const [exportName, value] of Object.entries(mod)) {
        if (!value || typeof value !== 'object') continue;
        const schema = value as z.ZodTypeAny;
        if (typeof schema._def !== 'object' || !(schema._def as { typeName?: string }).typeName) continue;
        for (const path of new Set(uuidPaths(schema))) {
          if (!path) continue;
          found.set(`${relative(root, file)}:${exportName}.${path}`, true);
        }
      }
    }

    const declared = new Set(Object.keys(UUID_FIELDS));
    const unaccounted = [...found.keys()].filter((k) => !declared.has(k)).sort();
    const stale = [...declared].filter((k) => !found.has(k)).sort();

    expect({ unaccounted, stale }).toEqual({ unaccounted: [], stale: [] });
  });

  it('says what stands behind each one', () => {
    // The list is only worth keeping if each line carries a reason someone can
    // check. A placeholder entry added to make the test above pass is the one
    // way this file could quietly stop meaning anything.
    const empty = Object.entries(UUID_FIELDS)
      .filter(([, v]) => v.by.trim().length < 20)
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });
});
