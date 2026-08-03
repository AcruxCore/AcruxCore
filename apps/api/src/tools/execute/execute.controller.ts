import { Request, Response, NextFunction } from 'express';
import { ToolExecuteService } from './execute.service';
import { ExecuteBodySchema } from './execute.types';

const service = new ToolExecuteService();

/**
 * POST /api/v1/tools/:id/execute
 * Runs an `http` tool server-side: resolves the version, validates arguments,
 * applies transforms, injects secrets, and issues the SSRF-guarded request.
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function executeToolHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = ExecuteBodySchema.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: body.error.errors[0]?.message ?? 'Invalid request' } });
      return;
    }
    const result = await service.execute(req.params['id']!, req.teamId!, body.data);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
