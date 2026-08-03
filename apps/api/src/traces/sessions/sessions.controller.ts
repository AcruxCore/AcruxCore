import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../shared/errors';
import { SessionsService } from './sessions.service';
import { SessionListQuerySchema } from './sessions.types';

/** `:id` is the caller-supplied session_id string — any non-empty value. */
const SessionIdSchema = z.string().min(1, 'Session id is required.');

/** HTTP boundary for the sessions read surface. Validates input, delegates, responds. */
export class SessionsController {
  constructor(private readonly service: SessionsService) {}

  /** GET /api/v1/sessions — paginated list of the team's sessions. */
  listSessions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = SessionListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.listSessions(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/sessions/:id — one session summary plus its traces (404 if unknown). */
  getSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = SessionIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const result = await this.service.getSession(req.teamId!, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
