import { Request, Response, NextFunction } from 'express';
import { FeedbackService } from './feedback.service';
import {
  CreateFeedbackSchema,
  FeedbackListQuerySchema,
  FeedbackSummaryQuerySchema,
  UpdateFeedbackSchema,
} from './feedback.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handlers for trace feedback. Assumes `req.teamId` is set by upstream auth
 * middleware; `req.user` is set for a logged-in user or a personal API key, and
 * undefined for a team-scoped API key.
 */
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  /** POST /api/v1/traces/:id/feedback — attach feedback (any member or API key). */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateFeedbackSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const createdBy = req.user?.id ?? null;
      const result = await this.service.create(req.teamId!, req.params.id, createdBy, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** PATCH /api/v1/traces/:id/feedback/:feedbackId — author-only edit in place. */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateFeedbackSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const requesterId = req.user?.id ?? null;
      const result = await this.service.update(
        req.teamId!,
        req.params.id,
        requesterId,
        req.params.feedbackId,
        parsed.data,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/traces/:id/feedback — list feedback newest-first (any member or API key). */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.list(req.teamId!, req.params.id);
      res.status(200).json({ data: result });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/traces/feedback — team-wide raw feed, newest-first, paginated (T10). */
  listAll = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = FeedbackListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.listForTeam(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/traces/feedback/summary — avg rating + counts by version/model. */
  summary = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = FeedbackSummaryQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.summary(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
