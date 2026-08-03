import { Request, Response, NextFunction } from 'express';
import { ToolSyncService } from './sync.service';
import { SyncToolBodySchema } from './sync.types';
import { ValidationError } from '../../shared/errors';

const service = new ToolSyncService();

/**
 * POST /api/v1/tools/sync
 * Creates-or-commits-or-does-nothing for a tool spec authored in code.
 *
 * Returns 200 in every case, including a creation: the caller cannot know in advance
 * whether this is the first sync, and "did anything change" is answered by `committed`
 * rather than by the status code.
 *
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function syncToolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = SyncToolBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]!.message);
    const result = await service.sync(req.teamId!, req.user!.id, parsed.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
