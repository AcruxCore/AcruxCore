import { Request, Response, NextFunction } from 'express';
import { DatasetsService } from './datasets.service';
import {
  AddExampleSchema,
  AddExamplesFromFeedbackSchema,
  BuildFromFeedbackSchema,
  CreateDatasetSchema,
  UpdateDatasetSchema,
  UpdateExampleSchema,
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
        // Present only for a `filter` request: how many rows the criteria matched
        // in total, so a selection capped at the per-request ceiling is visible
        // rather than silently truncated.
        ...(result.matched !== undefined ? { matched: result.matched } : {}),
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
      await this.service.deleteDataset(req.teamId!, req.params.id, req.user?.id ?? null);
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

  /**
   * POST /api/v1/datasets/:id/examples/from-feedback — append feedback rows to
   * an existing dataset.
   *
   * 201 when at least one example was created, 200 when none were — every id
   * was already in the dataset, or none was eligible. Both are normal outcomes
   * here (unlike the build path, which 422s on nothing eligible because it would
   * otherwise leave an empty dataset behind), so the status distinguishes
   * "something changed" from "nothing changed" without making the caller
   * compare counts.
   */
  addExamplesFromFeedback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = AddExamplesFromFeedbackSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.addExamplesFromFeedback(req.teamId!, req.params.id, parsed.data);
      res.status(result.added > 0 ? 201 : 200).json({
        added: result.added,
        example_count: result.exampleCount,
        skipped: result.skipped,
        ...(result.matched !== undefined ? { matched: result.matched } : {}),
      });
    } catch (err) {
      next(err);
    }
  };

  /** PATCH /api/v1/datasets/:id/examples/:exampleId — edit one example's criteria. */
  updateExample = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateExampleSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.updateExample(
        req.teamId!,
        req.params.id,
        req.params.exampleId,
        parsed.data,
      );
      res.status(200).json(result);
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
