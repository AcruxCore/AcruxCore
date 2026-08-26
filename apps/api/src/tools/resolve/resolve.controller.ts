import { Request, Response, NextFunction } from 'express';
import { ToolResolver, ToolRefsNotFoundError, describeToolRefFailure } from '../resolver';
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
 *
 * `refs` keeps its original shape so existing callers still read it; `failures` is the
 * same list with `reason` and a `message` attached, because a bare 404 naming neither the
 * tool nor the cause reads as "no such tool" even when the tool exists and simply has no
 * committed version (issue #349).
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
        error: {
          code: 'TOOL_REF_NOT_FOUND',
          message: err.message,
          refs: err.refs,
          failures: err.failures.map((f) => ({
            ...f.ref,
            reason: f.reason,
            message: describeToolRefFailure(f),
            ...(f.availableAliases ? { availableAliases: f.availableAliases } : {}),
            ...(f.latestVersion !== undefined ? { latestVersion: f.latestVersion } : {}),
          })),
        },
      });
      return;
    }
    next(err);
  }
}
