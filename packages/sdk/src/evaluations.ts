import { acruxcoreError } from './error';
import type {
  CreateDatasetParams,
  BuildFromFeedbackParams,
  BuildFromFeedbackResult,
  UpdateDatasetParams,
  AddExampleParams,
  DatasetDto,
  DatasetWithExamples,
  DatasetExampleDto,
  CreateExperimentParams,
  ExperimentDto,
  ExperimentRunDto,
  StartRunResult,
  ListRunsParams,
  RunListResponse,
  RunDetailDto,
  RunReport,
  RunCellDetailDto,
  CandidateDetail,
  PromoteCandidateParams,
  PromoteResult,
  StartOptimizeParams,
  StartOptimizeResult,
} from './eval-types';
import type { NamespaceHost } from './host';

export type EvaluationsHost = NamespaceHost;

// ── Datasets ──

export class DatasetsNamespace {
  private readonly client: EvaluationsHost;

  constructor(client: EvaluationsHost) {
    this.client = client;
  }

  async create(params: CreateDatasetParams): Promise<DatasetDto> {
    const response = await this.client._request('POST', '/datasets', params as unknown as Record<string, unknown>, 'creating dataset');
    return this.client._parseJsonOrThrow(response, 'creating dataset') as Promise<DatasetDto>;
  }

  async buildFromFeedback(params: BuildFromFeedbackParams): Promise<BuildFromFeedbackResult> {
    const body = {
      name: params.name,
      ...(params.overallFeedback !== undefined ? { overall_feedback: params.overallFeedback } : {}),
      feedback_ids: params.feedbackIds,
    };
    const response = await this.client._request('POST', '/datasets/from-feedback', body, 'building dataset from feedback');
    return this.client._parseJsonOrThrow(response, 'building dataset from feedback') as Promise<BuildFromFeedbackResult>;
  }

  async list(): Promise<DatasetDto[]> {
    const response = await this.client._request('GET', '/datasets', undefined, 'listing datasets');
    const data = await this.client._parseJsonOrThrow(response, 'listing datasets') as { data?: DatasetDto[] };
    return data.data ?? [];
  }

  async get(id: string): Promise<DatasetWithExamples> {
    const response = await this.client._request('GET', `/datasets/${encodeURIComponent(id)}`, undefined, 'getting dataset');
    return this.client._parseJsonOrThrow(response, 'getting dataset') as Promise<DatasetWithExamples>;
  }

  async update(id: string, params: UpdateDatasetParams): Promise<DatasetDto> {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body['name'] = params.name;
    if (params.overallFeedback !== undefined) body['overall_feedback'] = params.overallFeedback;
    const response = await this.client._request('PATCH', `/datasets/${encodeURIComponent(id)}`, body, 'updating dataset');
    return this.client._parseJsonOrThrow(response, 'updating dataset') as Promise<DatasetDto>;
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const response = await this.client._request('DELETE', `/datasets/${encodeURIComponent(id)}`, undefined, 'deleting dataset');
    return this.client._parseJsonOrThrow(response, 'deleting dataset') as Promise<{ success: boolean }>;
  }

  async addExample(datasetId: string, params: AddExampleParams): Promise<DatasetExampleDto> {
    const response = await this.client._request('POST', `/datasets/${encodeURIComponent(datasetId)}/examples`, params as unknown as Record<string, unknown>, 'adding example');
    return this.client._parseJsonOrThrow(response, 'adding example') as Promise<DatasetExampleDto>;
  }

  async removeExample(datasetId: string, exampleId: string): Promise<{ success: boolean }> {
    const response = await this.client._request('DELETE', `/datasets/${encodeURIComponent(datasetId)}/examples/${encodeURIComponent(exampleId)}`, undefined, 'removing example');
    return this.client._parseJsonOrThrow(response, 'removing example') as Promise<{ success: boolean }>;
  }
}

// ── Experiments ──

export class ExperimentsNamespace {
  private readonly client: EvaluationsHost;

  constructor(client: EvaluationsHost) {
    this.client = client;
  }

  async create(params: CreateExperimentParams): Promise<ExperimentDto> {
    const body = {
      dataset_id: params.datasetId,
      ...(params.promptId !== undefined ? { prompt_id: params.promptId } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      version_ids: params.versionIds,
      models: params.models,
      ...(params.alias !== undefined ? { alias: params.alias } : {}),
    };
    const response = await this.client._request('POST', '/experiments', body, 'creating experiment');
    return this.client._parseJsonOrThrow(response, 'creating experiment') as Promise<ExperimentDto>;
  }

  async list(): Promise<ExperimentDto[]> {
    const response = await this.client._request('GET', '/experiments', undefined, 'listing experiments');
    const data = await this.client._parseJsonOrThrow(response, 'listing experiments') as { data?: ExperimentDto[] };
    return data.data ?? [];
  }

  async get(id: string): Promise<ExperimentDto> {
    const response = await this.client._request('GET', `/experiments/${encodeURIComponent(id)}`, undefined, 'getting experiment');
    return this.client._parseJsonOrThrow(response, 'getting experiment') as Promise<ExperimentDto>;
  }

  async startRun(experimentId: string): Promise<StartRunResult> {
    const response = await this.client._request('POST', `/experiments/${encodeURIComponent(experimentId)}/runs`, undefined, 'starting run');
    const data = await this.client._parseJsonOrThrow(response, 'starting run') as { run_id: string; status: string };
    return { runId: data.run_id, status: data.status };
  }
}

// ── Runs ──

export class RunsNamespace {
  private readonly client: EvaluationsHost;

  constructor(client: EvaluationsHost) {
    this.client = client;
  }

  async list(params: ListRunsParams = {}): Promise<RunListResponse> {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.datasetId) qs.set('dataset_id', params.datasetId);
    if (params.promptId) qs.set('prompt_id', params.promptId);
    if (params.page !== undefined) qs.set('page', String(params.page));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const query = qs.toString();
    const path = `/runs${query ? `?${query}` : ''}`;
    const response = await this.client._request('GET', path, undefined, 'listing runs');
    return this.client._parseJsonOrThrow(response, 'listing runs') as Promise<RunListResponse>;
  }

  async get(id: string): Promise<RunDetailDto> {
    const response = await this.client._request('GET', `/runs/${encodeURIComponent(id)}`, undefined, 'getting run');
    return this.client._parseJsonOrThrow(response, 'getting run') as Promise<RunDetailDto>;
  }

  async getReport(id: string): Promise<RunReport> {
    const response = await this.client._request('GET', `/runs/${encodeURIComponent(id)}/report`, undefined, 'getting run report');
    return this.client._parseJsonOrThrow(response, 'getting run report') as Promise<RunReport>;
  }

  async getCell(id: string, cellKey: string): Promise<RunCellDetailDto> {
    const response = await this.client._request('GET', `/runs/${encodeURIComponent(id)}/cells/${encodeURIComponent(cellKey)}`, undefined, 'getting run cell');
    return this.client._parseJsonOrThrow(response, 'getting run cell') as Promise<RunCellDetailDto>;
  }

  async getCandidate(id: string, candidateId: string): Promise<CandidateDetail> {
    const response = await this.client._request('GET', `/runs/${encodeURIComponent(id)}/candidates/${encodeURIComponent(candidateId)}`, undefined, 'getting candidate');
    return this.client._parseJsonOrThrow(response, 'getting candidate') as Promise<CandidateDetail>;
  }

  async promoteCandidate(id: string, params: PromoteCandidateParams): Promise<PromoteResult> {
    const body: Record<string, unknown> = { prompt_candidate_id: params.promptCandidateId };
    if (params.alias !== undefined) body['alias'] = params.alias;
    const response = await this.client._request('POST', `/runs/${encodeURIComponent(id)}/promote`, body, 'promoting candidate');
    return this.client._parseJsonOrThrow(response, 'promoting candidate') as Promise<PromoteResult>;
  }
}

// ── Optimize ──

export class OptimizeNamespace {
  private readonly client: EvaluationsHost;

  constructor(client: EvaluationsHost) {
    this.client = client;
  }

  async start(promptId: string, params: StartOptimizeParams): Promise<StartOptimizeResult> {
    const body: Record<string, unknown> = {
      dataset_id: params.datasetId,
      models: params.models,
    };
    if (params.draftCount !== undefined) body['draft_count'] = params.draftCount;
    if (params.alias !== undefined) body['alias'] = params.alias;
    const response = await this.client._request('POST', `/prompts/${encodeURIComponent(promptId)}/optimize`, body, 'starting optimize');
    const data = await this.client._parseJsonOrThrow(response, 'starting optimize') as { run_id: string; status: string; prompt_mismatch_warning?: StartOptimizeResult['promptMismatchWarning'] };
    return { runId: data.run_id, status: data.status, promptMismatchWarning: data.prompt_mismatch_warning };
  }
}
