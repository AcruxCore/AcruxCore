import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../../../shared/errors';
import { OtlpService } from './otlp.service';

/**
 * HTTP boundary for the OTLP/HTTP trace receiver. Validates that a body is
 * present, delegates decoding/translation/ingestion to {@link OtlpService}, and
 * responds — the same validate → call service → respond shape as the native
 * JSON ingestion controller (`ingest.controller.ts`).
 */
export class OtlpController {
  /**
   * @param service - The OTLP decode-and-ingest use case.
   */
  constructor(private readonly service: OtlpService) {}

  /**
   * `POST /api/v1/traces/otlp` — accepts one `ExportTraceServiceRequest`.
   *
   * Errors are forwarded untouched, exactly as `ingest.controller.ts` does:
   * {@link OtlpService} already turns a genuinely malformed export into a typed
   * 400, so anything else reaching here is a real server-side fault and must
   * surface as one. Rewrapping everything as a 400 both leaked internal error
   * text and told the exporter — for which 4xx means non-retryable — to
   * permanently discard a batch that a retry would have delivered.
   *
   * @throws {ValidationError} 400 if the body is empty.
   */
  ingest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const contentType = req.headers['content-type'] ?? '';
      if (!req.body || (Buffer.isBuffer(req.body) && req.body.length === 0)) {
        throw new ValidationError('Request body is empty.');
      }

      await this.service.ingestOtlp(req.teamId!, req.body, contentType);

      // Empty ExportTraceServiceResponse — an empty JSON object is a valid,
      // spec-compliant success response for both content types.
      res.status(200).json({});
    } catch (err) {
      next(err);
    }
  };
}
