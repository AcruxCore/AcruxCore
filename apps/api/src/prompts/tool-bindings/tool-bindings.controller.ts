import { Request, Response, NextFunction } from 'express';
import { ToolBindingsService } from './tool-bindings.service';
import { SetBindingBodySchema } from './tool-bindings.types';

const service = new ToolBindingsService();

/** Parses and responds 400 on failure; returns undefined when the body is invalid. */
function parseBody(req: Request, res: Response): ReturnType<typeof SetBindingBodySchema.safeParse>['data'] | undefined {
  const body = SetBindingBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: body.error.errors[0]?.message ?? 'Invalid request' },
    });
    return undefined;
  }
  return body.data;
}

/**
 * GET /api/v1/prompts/:id/tools
 * The prompt's default bindings plus every alias, with a `customised` flag.
 * Auth: requireAnyAuth (any role) — enforced in router.
 */
export async function listBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.list(req.params['id']!, req.teamId!);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/v1/prompts/:id/tools/:toolId
 * Sets the default binding, which every alias without its own row inherits.
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function setDefaultBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = parseBody(req, res);
    if (!data) return;

    const result = await service.set(
      req.params['id']!,
      req.teamId!,
      req.user!.id,
      null,
      req.params['toolId']!,
      data,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/prompts/:id/tools/:toolId
 * Unbinds a tool from the prompt entirely, for every alias inheriting the default.
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function removeDefaultBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.remove(req.params['id']!, req.teamId!, req.user!.id, null, req.params['toolId']!);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/v1/prompts/:id/aliases/:alias/tools/:toolId
 * Sets one alias's own binding, overriding the default for that alias only.
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function setAliasBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = parseBody(req, res);
    if (!data) return;

    const result = await service.set(
      req.params['id']!,
      req.teamId!,
      req.user!.id,
      req.params['alias']!,
      req.params['toolId']!,
      data,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/prompts/:id/aliases/:alias/tools/:toolId
 * Drops one alias's row for a tool, returning that pair to the default.
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function removeAliasBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.remove(
      req.params['id']!,
      req.teamId!,
      req.user!.id,
      req.params['alias']!,
      req.params['toolId']!,
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/prompts/:id/aliases/:alias/tools
 * Drops every row this alias owns, returning it wholesale to the default.
 * Auth: requireAnyAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function resetAliasBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.resetAlias(req.params['id']!, req.teamId!, req.user!.id, req.params['alias']!);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
