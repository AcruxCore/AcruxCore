import { Request, Response, NextFunction } from 'express';
import { ToolVersionsService } from './versions.service';
import { CreateToolVersionBodySchema, ListToolVersionsQuerySchema } from './versions.types';

const service = new ToolVersionsService();

/**
 * POST /api/v1/tools/:id/versions
 * Commits a new immutable version for a tool.
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function createToolVersionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = CreateToolVersionBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: body.error.errors[0]?.message ?? 'Invalid request' } });
      return;
    }
    const { version, aliases, warnings } = await service.commitVersion(req.params['id']!, req.teamId!, req.user!.id, body.data);
    res.status(201).json({ ...version, ...(aliases ? { aliases } : {}), ...(warnings ? { warnings } : {}) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/tools/:id/versions
 * Lists all versions for a tool, newest first, without parametersSchema/executor.
 * Auth: requireAnyAuth (any role) — enforced in router.
 */
export async function listToolVersionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = ListToolVersionsQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: query.error.errors[0]?.message ?? 'Invalid query params' } });
      return;
    }
    const result = await service.listVersions(req.params['id']!, req.teamId!, query.data.page, query.data.limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/tools/:id/versions/:version_number
 * Fetches a specific version including full parametersSchema/executor.
 * Auth: requireAnyAuth (any role) — enforced in router.
 */
export async function getToolVersionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const n = Number(req.params['version_number']);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'version_number must be a positive integer' } });
      return;
    }
    const version = await service.getVersion(req.params['id']!, req.teamId!, n);
    res.status(200).json(version);
  } catch (err) {
    next(err);
  }
}
