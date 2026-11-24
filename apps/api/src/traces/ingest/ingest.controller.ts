import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../shared/errors';
import { IngestService } from './ingest.service';
import { IngestBatchSchema } from './ingest.types';

/**
 * HTTP boundary for trace ingestion. Validates the OTel-shaped batch body and
 * delegates to {@link IngestService}. Team scope comes from `req.teamId!`, set by
 * `requireAnyAuthOrVirtualKey` (session, personal key, or virtual key).
 */
export class IngestController {
  /**
   * @param service - The ingestion use-case service.
   */
  constructor(private readonly service: IngestService) {}

  /**
   * `POST /api/v1/traces` — ingest a batch of traces.
   *
   * Idempotent on (trace id, span id): the SDKs re-send a batch when the server was
   * unreachable or answered 5xx, and a re-send of a batch that was in fact stored (only
   * its reply was lost) must store nothing twice.
   *
   * @throws {ValidationError} 400 if the body fails schema validation.
   */
  ingest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = IngestBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0].message);
      }
      const result = await this.service.ingest(req.teamId!, parsed.data.traces, { idempotent: true });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
