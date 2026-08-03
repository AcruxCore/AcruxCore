import { Request, Response, NextFunction } from 'express';
import { ToolsService } from './tools.service';
import { CreateToolSchema, UpdateToolSchema, ListToolsQuerySchema } from './tools.types';
import { ValidationError } from '../shared/errors';

/**
 * HTTP handlers for the tools domain (Tool shell CRUD).
 * Each handler: validate → call service → respond. No business logic here.
 */
export class ToolsController {
  constructor(private readonly service: ToolsService) {}

  /**
   * POST /api/v1/tools
   * Creates a new tool shell and returns the created resource.
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = CreateToolSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.create(req.user!.id, req.teamId!, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/tools
   * Returns a paginated list of active tools for the current team.
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListToolsQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.list(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/tools/:id
   * Returns a single active tool by ID.
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
   * PATCH /api/v1/tools/:id
   * Partially updates a tool's name and/or description.
   */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = UpdateToolSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.update(req.params.id, req.teamId!, req.user!.id, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /api/v1/tools/:id
   * Soft-deletes a tool. Returns 204 No Content on success.
   */
  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await this.service.remove(req.params.id, req.teamId!);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
