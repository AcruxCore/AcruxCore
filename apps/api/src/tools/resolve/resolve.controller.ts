import { Request, Response, NextFunction } from 'express';
import { ToolResolver, ToolRefsNotFoundError } from '../resolver';
import { ResolveToolsBodySchema, type ResolveToolsResponse } from './resolve.types';
import { ValidationError } from '../../shared/errors';

const resolver = new ToolResolver();

/**
 * POST /api/v1/tools/resolve
 * Resolves a batch of `{ name, alias }` refs to schemas plus `executorType`.
 * Auth: requireAnyAuth, any role — resolving is a read.
 *
 * The 404 is built here rather than thrown as an `AppError` because it carries a `refs`
 * array, which the shared error middleware's `{ code, message }` envelope has no field
 * for — and naming every failing ref is the point of the endpoint being batch.
 */
export async function resolveToolsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = ResolveToolsBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]!.message);

    const data = await resolver.resolveRefsDetailed(req.teamId!, parsed.data.refs);
    const body: ResolveToolsResponse = { data };
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof ToolRefsNotFoundError) {
      res.status(404).json({
        error: { code: 'TOOL_REF_NOT_FOUND', message: err.message, refs: err.refs },
      });
      return;
    }
    next(err);
  }
}
