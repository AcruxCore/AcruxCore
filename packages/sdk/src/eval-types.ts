// ── Dataset types ──

export interface DatasetDto {
  id: string;
  teamId: string;
  name: string;
  overallFeedback: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  exampleCount: number;
}

export interface DatasetExampleDto {
  id: string;
  datasetId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  history: EvalChatMessage[] | null;
  sourceTraceId: string | null;
  sourceFeedbackId: string | null;
  sourcePromptVersionId: string | null;
  createdAt: string;
}

export interface EvalChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface DatasetWithExamples extends DatasetDto {
  examples: DatasetExampleDto[];
}

export interface CreateDatasetParams {
  name: string;
  overallFeedback?: string;
}

export interface BuildFromFeedbackParams {
  name: string;
  feedbackIds: string[];
  overallFeedback?: string;
}

export interface BuildFromFeedbackResult {
  id: string;
  name: string;
  overallFeedback: string | null;
  exampleCount: number;
  skipped: Array<{ feedbackId: string; reason: string }>;
}

export interface UpdateDatasetParams {
  name?: string;
  overallFeedback?: string | null;
}

export interface AddExampleParams {
  input: Record<string, unknown>;
  criteria?: string;
  history?: EvalChatMessage[];
}

// ── Experiment types ──

export interface ExperimentDto {
  id: string;
  teamId: string;
  datasetId: string;
  promptId: string | null;
  name: string | null;
  config: {
    versionIds: string[];
    models: string[];
    alias?: string;
  };
  createdBy: string | null;
  createdAt: string;
  runs: ExperimentRunDto[];
  promptMismatchWarning?: {
    mismatchedPrompts: Array<{ promptId: string; name: string; exampleCount: number }>;
  };
}

export interface ExperimentRunDto {
  id: string;
  experimentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface CreateExperimentParams {
  datasetId: string;
  promptId?: string;
  name?: string;
  versionIds: string[];
  models: string[];
  alias?: string;
}

// ── Run types ──

export interface StartRunResult {
  runId: string;
  status: string;
}

export interface ListRunsParams {
  status?: string;
  datasetId?: string;
  promptId?: string;
  page?: number;
  limit?: number;
}

export interface RunListItemDto {
  id: string;
  status: string;
  kind: 'evaluation' | 'optimize';
  experimentId: string;
  experimentName: string | null;
  datasetId: string;
  datasetName: string;
  promptId: string | null;
  promptName: string | null;
  variantCount: number;
  modelCount: number;
  exampleCount: number;
  results: { total: number; succeeded: number; errored: number; scored: number };
  avgScore: number | null;
  passRate: number | null;
  topVariantLabel: string | null;
  startedBy: { id: string; name: string; email: string } | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

export interface RunListResponse {
  data: RunListItemDto[];
  total: number;
  page: number;
  limit: number;
}

export interface RunGridCell {
  cellKey: string;
  variantKind: string;
  promptVersionId?: string;
  promptCandidateId?: string;
  variantLabel: string;
  model: string;
  isProductionBaseline: boolean;
}

export interface RunDetailDto {
  id: string;
  experimentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  createdAt: string;
  grid: RunGridCell[];
  exampleCount: number;
  results: { total: number; succeeded: number; errored: number };
}

export interface RunReportCell {
  cellKey: string;
  variantLabel: string;
  model: string;
  isProductionBaseline: boolean;
  avgScore: number | null;
  passRate: number | null;
  exampleCount: number;
  scoredCount: number;
  unscoredCount: number;
  deltaVsBaseline: {
    score: number | null;
    passRate: number | null;
    label: 'improved' | 'regressed' | 'flat' | 'unknown';
  } | null;
}

export interface RunReport {
  runId: string;
  status: string;
  models: string[];
  variants: Array<{
    variantKind: 'version' | 'candidate';
    promptVersionId: string | null;
    variantLabel: string;
    isProductionBaseline: boolean;
  }>;
  cells: RunReportCell[];
  leaderboard: string[];
  winner: {
    cellKey: string;
    variantLabel: string;
    model: string;
    avgScore: number;
  } | null;
}

export interface RunCellExampleDto {
  exampleId: string;
  input: Record<string, unknown>;
  criteria: string | null;
  history: EvalChatMessage[] | null;
  output: unknown;
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  traceId: string | null;
  judgeTraceId: string | null;
}

export interface RunCellDetailDto {
  cellKey: string;
  variantLabel: string;
  model: string;
  examples: RunCellExampleDto[];
}

export interface CandidateDetail {
  id: string;
  promptId: string;
  messages: Array<{ role: string; content: string }>;
  rationale: string | null;
  label: string;
  createdAt: string;
}

export interface PromoteCandidateParams {
  promptCandidateId: string;
  alias?: string;
}

export interface PromoteResult {
  version: {
    id: string;
    promptId: string;
    versionNumber: number;
    messages: Array<{ role: string; content: string }>;
    variables: string[];
    model: string | null;
    createdBy: string;
    createdAt: string;
  };
  alias: {
    id: string;
    alias: string;
    versionId: string;
    versionNumber: number;
    updatedAt: string;
  };
}

// ── Optimize types ──

export interface StartOptimizeParams {
  datasetId: string;
  models: string[];
  draftCount?: number;
  alias?: string;
}

export interface StartOptimizeResult {
  runId: string;
  status: string;
  promptMismatchWarning?: {
    mismatchedPrompts: Array<{ promptId: string; name: string; exampleCount: number }>;
  };
}
