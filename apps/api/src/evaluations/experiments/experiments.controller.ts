import { Request, Response, NextFunction } from 'express';
import { ExperimentsService } from './experiments.service';
import { CreateExperimentSchema } from './experiments.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for the experiments domain. Assumes `req.teamId` is set by
 * upstream auth middleware; `req.user` is set for a logged-in user or a
 * personal API key, and undefined for a team-scoped API key.
 */
export class ExperimentsController {
  constructor(private readonly service: ExperimentsService) {}

  /** POST /api/v1/experiments — create an experiment (dataset + version/model grid). */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateExperimentSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const userId = req.user?.id ?? null;
      const result = await this.service.create(req.teamId!, userId, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/experiments — list the team's experiments. */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.list(req.teamId!);
      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/experiments/:id — get one experiment with its runs. */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getById(req.teamId!, req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
