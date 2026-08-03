import { Request, Response, NextFunction } from 'express';
import { ToolAliasesService } from './aliases.service';
import { PromoteToolAliasBodySchema } from './aliases.types';

const service = new ToolAliasesService();

/**
 * GET /api/v1/tools/:id/aliases
 * Lists all aliases for a tool with their target version numbers.
 * Auth: requireAnyAuth (any role) — enforced in router.
 */
export async function listToolAliasesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const aliases = await service.listAliases(req.params['id']!, req.teamId!);
    res.status(200).json(aliases);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/tools/:id/aliases/:alias/promote
 * Moves an alias to a different version (promotes forward or rolls back).
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function promoteToolAliasHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = PromoteToolAliasBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: body.error.errors[0]?.message ?? 'Invalid request',
        },
      });
      return;
    }

    const result = await service.promoteAlias(
      req.params['id']!,
      req.teamId!,
      req.user!.id,
      req.params['alias']!,
      body.data,
    );

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
