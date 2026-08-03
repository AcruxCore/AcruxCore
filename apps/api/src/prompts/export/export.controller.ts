import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ExportService } from './export.service';

const exportService = new ExportService();

const PathSchema = z.object({
  id:             z.string().uuid(),
  version_number: z.coerce.number().int().min(1),
});

/**
 * GET /api/v1/prompts/:id/versions/:version_number/export
 * Downloads a prompt version as a portable JSON file with Content-Disposition header.
 */
export async function exportVersion(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = PathSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid path parameters.' },
      });
      return;
    }

    const { id, version_number } = parsed.data;
    const exportData = await exportService.exportVersion(id, req.teamId!, version_number);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { promptName, ...responseBody } = exportData;
    const filename = `${promptName}-v${version_number}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).json(responseBody);
  } catch (err) {
    next(err);
  }
}
