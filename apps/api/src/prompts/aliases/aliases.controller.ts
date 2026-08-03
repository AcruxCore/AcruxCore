import { Request, Response, NextFunction } from 'express';
import { AliasesService } from './aliases.service';
import { PromoteAliasBodySchema, RenderBodySchema } from './aliases.types';
import { AppError } from '../../shared/errors/app-error';

const service = new AliasesService();

/**
 * GET /api/v1/prompts/:id/aliases
 * Lists all aliases for a prompt with their target version numbers.
 * Auth: requireAuth (any role) — enforced in router.
 */
export async function listAliasesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const aliases = await service.listAliases(req.params['id']!, req.teamId!);
    res.status(200).json(aliases);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/prompts/:id/aliases/:alias/promote
 * Moves an alias to a different version (promotes forward or rolls back).
 * Auth: requireAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function promoteAliasHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = PromoteAliasBodySchema.safeParse(req.body);
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

/**
 * DELETE /api/v1/prompts/:id/aliases/:alias
 * Deletes a custom alias (production/staging are protected).
 * Auth: requireAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function deleteAliasHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await service.deleteAlias(
      req.params['id']!,
      req.teamId!,
      req.user!.id,
      req.params['alias']!,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/prompts/:name/:alias/render
 * Resolves an alias, renders the nunjucks template, returns OpenAI-compatible messages.
 * Auth: requireAuth (accepts both session and API key) — enforced in router.
 */
export async function renderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = RenderBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: body.error.errors[0]?.message ?? 'Invalid request',
        },
      });
      return;
    }

    const result = await service.render(
      req.teamId!,
      req.params['name']!,
      req.params['alias']!,
      body.data.variables,
    );

    res.status(200).json(result);
  } catch (err) {
    // Special handling for MISSING_VARIABLES to include the `missing` array in response
    if (err instanceof AppError && err.code === 'MISSING_VARIABLES' && err.details?.['missing']) {
      res.status(400).json({
        error: {
          code: 'MISSING_VARIABLES',
          message: err.message,
          missing: err.details['missing'],
        },
      });
      return;
    }
    next(err);
  }
}
