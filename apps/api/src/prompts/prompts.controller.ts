import { Request, Response, NextFunction } from 'express';
import { PromptsService } from './prompts.service';
import {
  CreatePromptSchema,
  UpdatePromptSchema,
  ListPromptsQuerySchema,
} from './prompts.types';
import { ValidationError } from '../shared/errors';

/**
 * HTTP handlers for the prompts domain.
 * Each handler: validate → call service → respond. No business logic here.
 */
export class PromptsController {
  constructor(private readonly service: PromptsService) {}

  /**
   * POST /api/v1/prompts
   * Creates a new prompt shell and returns the created resource.
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreatePromptSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.create(req.user!.id, req.teamId!, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/prompts
   * Returns a paginated list of active prompts for the current team.
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListPromptsQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.list(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/prompts/:id
   * Returns a single active prompt by ID.
   */
  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getById(req.params.id, req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * PATCH /api/v1/prompts/:id
   * Partially updates a prompt's name and/or description.
   */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdatePromptSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.update(
        req.params.id,
        req.teamId!,
        req.user!.id,
        parsed.data,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /api/v1/prompts/:id
   * Soft-deletes a prompt. Returns 204 No Content on success.
   */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.delete(req.params.id, req.teamId!, req.user!.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
