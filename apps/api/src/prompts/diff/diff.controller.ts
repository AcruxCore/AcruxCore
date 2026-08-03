import type { Request, Response, NextFunction } from 'express';
import { DiffQuerySchema } from './diff.types';
import { DiffService } from './diff.service';

const diffService = new DiffService();

/**
 * GET /api/v1/prompts/:id/versions/diff
 * Returns a unified diff string between two versions of a prompt.
 * Query params: `from` and `to` (required, positive integers).
 */
export async function getDiff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = DiffQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'from and to are required positive integers.' },
      });
      return;
    }

    const { from, to } = parsed.data;
    const result = await diffService.computeDiff(req.params.id!, req.teamId!, from, to);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
