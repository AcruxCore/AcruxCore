import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../shared/errors';
import { TraceQueryService } from './query.service';
import { TraceListQuerySchema, PromptVersionTracesQuerySchema } from './query.types';

const TraceIdSchema = z.string().uuid('Invalid trace id.');
const PromptIdSchema = z.string().uuid('Invalid prompt id.');
const VersionNumberSchema = z.coerce.number().int().positive('Invalid version number.');

/** HTTP boundary for the trace query surface. Validates input, delegates, responds. */
export class TraceQueryController {
  constructor(private readonly service: TraceQueryService) {}

  /** GET /api/v1/traces — paginated, filtered trace list. */
  listTraces = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = TraceListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.listTraces(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/traces/:id — full trace detail with span tree. */
  getTrace = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = TraceIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.getTrace(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/prompts/:id/versions/:n/traces — reverse prompt-version lineage. */
  tracesForPromptVersion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const promptId = PromptIdSchema.safeParse(req.params.id);
      if (!promptId.success) throw new ValidationError(promptId.error.issues[0].message);
      const versionNumber = VersionNumberSchema.safeParse(req.params.n);
      if (!versionNumber.success) throw new ValidationError(versionNumber.error.issues[0].message);
      const query = PromptVersionTracesQuerySchema.safeParse(req.query);
      if (!query.success) throw new ValidationError(query.error.issues[0].message);

      const result = await this.service.tracesForPromptVersion(
        req.teamId!,
        promptId.data,
        versionNumber.data,
        query.data,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
