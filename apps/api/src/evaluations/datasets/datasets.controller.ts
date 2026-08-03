import { Request, Response, NextFunction } from 'express';
import { DatasetsService } from './datasets.service';
import {
  AddExampleSchema,
  BuildFromFeedbackSchema,
  CreateDatasetSchema,
  UpdateDatasetSchema,
} from './datasets.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for the datasets domain. Assumes `req.teamId` is set by
 * upstream auth middleware; `req.user` is set for a logged-in user or a
 * personal API key, and undefined for a team-scoped API key.
 */
export class DatasetsController {
  constructor(private readonly service: DatasetsService) {}

  /** POST /api/v1/datasets/from-feedback — build a dataset from selected feedback rows. */
  buildFromFeedback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = BuildFromFeedbackSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const userId = req.user?.id ?? null;
      const result = await this.service.buildFromFeedback(req.teamId!, userId, parsed.data);
      res.status(201).json({
        id: result.dataset.id,
        name: result.dataset.name,
        overall_feedback: result.dataset.overallFeedback,
        example_count: result.exampleCount,
        skipped: result.skipped,
      });
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/v1/datasets — create an empty dataset. */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateDatasetSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const userId = req.user?.id ?? null;
      const result = await this.service.createDataset(req.teamId!, userId, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/datasets — list the team's non-deleted datasets. */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.listDatasets(req.teamId!);
      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/datasets/:id — get one dataset with its examples. */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getDataset(req.teamId!, req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** PATCH /api/v1/datasets/:id — update a dataset's name and/or overall_feedback. */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateDatasetSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.updateDataset(req.teamId!, req.params.id, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /api/v1/datasets/:id — soft-delete a dataset. */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.deleteDataset(req.teamId!, req.params.id);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  };

  /** POST /api/v1/datasets/:id/examples — add one example to a dataset. */
  addExample = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = AddExampleSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.addExample(req.teamId!, req.params.id, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** DELETE /api/v1/datasets/:id/examples/:exampleId — remove one example from a dataset. */
  removeExample = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.removeExample(req.teamId!, req.params.id, req.params.exampleId);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  };
}
