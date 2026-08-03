import type { Request, Response, NextFunction } from 'express';
import { ImportBodySchema } from './import.types';
import { ImportService } from './import.service';

const importService = new ImportService();

/**
 * POST /api/v1/prompts/import
 * Creates a new prompt + version 1 + aliases from an export file.
 * Rejects schemaVersion !== 1 with UNSUPPORTED_SCHEMA_VERSION.
 * Name collisions are resolved automatically — never returned as errors.
 */
export async function importPrompt(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = ImportBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      const isSchemaVersionError =
        firstError?.path[0] === 'schemaVersion' || firstError?.message === 'UNSUPPORTED_SCHEMA_VERSION';

      if (isSchemaVersionError) {
        res.status(400).json({
          error: { code: 'UNSUPPORTED_SCHEMA_VERSION', message: 'Only schemaVersion 1 is supported.' },
        });
        return;
      }

      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: firstError?.message ?? 'Invalid import payload.' },
      });
      return;
    }

    const result = await importService.importPrompt(req.teamId!, req.user!.id, parsed.data);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}
