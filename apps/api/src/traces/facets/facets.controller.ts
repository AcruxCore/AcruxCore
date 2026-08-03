import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../shared/errors';
import { TraceFacetsService } from './facets.service';
import { FacetValuesQuerySchema } from './facets.types';

/** HTTP boundary for trace facet discovery (T8). */
export class TraceFacetsController {
  constructor(private readonly service: TraceFacetsService) {}

  /** GET /api/v1/traces/facets — distinct tags + metadata keys for the team. */
  getFacets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getFacets(req.teamId!);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/traces/facets/values?key= — distinct values for one metadata key. */
  getMetadataValues = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = FacetValuesQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
      const values = await this.service.getMetadataValues(req.teamId!, parsed.data.key);
      res.status(200).json({ values });
    } catch (err) {
      next(err);
    }
  };
}
