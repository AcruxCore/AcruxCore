import { Request, Response, NextFunction } from 'express';
import { VersionsService } from './versions.service';
import { CreateVersionBodySchema, ListVersionsQuerySchema } from './versions.types';

const service = new VersionsService();

/**
 * POST /api/v1/prompts/:id/versions
 * Commits a new immutable version for a prompt.
 * Auth: requireAuth + requireRole('owner', 'admin', 'editor') — enforced in router.
 */
export async function createVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = CreateVersionBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: body.error.errors[0]?.message ?? 'Invalid request' },
      });
      return;
    }

    const { version, aliases } = await service.commitVersion(
      req.params['id']!,
      req.teamId!,
      req.user!.id,
      body.data,
    );

    res.status(201).json({ ...version, ...(aliases ? { aliases } : {}) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/prompts/:id/versions
 * Lists all versions for a prompt, newest first, without message content.
 * Auth: requireAuth (any role) — enforced in router.
 */
export async function listVersionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = ListVersionsQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: query.error.errors[0]?.message ?? 'Invalid query params' },
      });
      return;
    }

    const result = await service.listVersions(
      req.params['id']!,
      req.teamId!,
      query.data.page,
      query.data.limit,
    );

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/prompts/:id/versions/:version_number
 * Fetches a specific version including full message content.
 * Auth: requireAuth (any role) — enforced in router.
 */
export async function getVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vn = parseInt(req.params['version_number']!, 10);
    if (isNaN(vn) || vn < 1) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'version_number must be a positive integer' },
      });
      return;
    }

    const version = await service.getVersion(req.params['id']!, req.teamId!, vn);
    res.status(200).json(version);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/prompt-versions/:versionId
 * Resolves a version UUID to its prompt + raw messages (Playground prefill).
 * Auth: requireAnyAuth (any role) — enforced in router.
 */
export async function getVersionByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const version = await service.getVersionById(req.params['versionId']!, req.teamId!);
    res.status(200).json(version);
  } catch (err) {
    next(err);
  }
}
