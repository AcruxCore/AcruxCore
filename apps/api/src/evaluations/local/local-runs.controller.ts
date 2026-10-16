import { Request, Response, NextFunction } from 'express';
import { LocalRunsService } from './local-runs.service';
import { CreateLocalExperimentSchema, FinishLocalRunSchema, SubmitLocalResultsSchema } from './local-runs.types';
import { RunsService } from '../runs/runs.service';
import { ValidationError, firstIssueMessage } from '../../shared/errors';

/**
 * HTTP handlers for local experiments (phase-5 FAQ Q46). Assumes `req.teamId`
 * is set by upstream auth; `req.user` is undefined for a team-scoped API key.
 */
export class LocalRunsController {
  constructor(
    private readonly service: LocalRunsService,
    private readonly runs: RunsService,
  ) {}

  /** POST /api/v1/experiments/local — create a local experiment and its running run. */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateLocalExperimentSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(firstIssueMessage(parsed.error.issues));
      const result = await this.service.createLocalExperiment(req.teamId!, req.user?.id ?? null, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/v1/runs/:id/results — upload a batch of results a local run produced. */
  submitResults = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = SubmitLocalResultsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(firstIssueMessage(parsed.error.issues));
      const result = await this.service.submitResults(req.teamId!, req.params.id, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/v1/runs/:id/finish — close a local run; responds with the run's detail. */
  finish = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = FinishLocalRunSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError(firstIssueMessage(parsed.error.issues));
      await this.service.finishRun(req.teamId!, req.params.id, parsed.data);
      res.status(200).json(await this.runs.getRun(req.teamId!, req.params.id));
    } catch (err) {
      next(err);
    }
  };
}
