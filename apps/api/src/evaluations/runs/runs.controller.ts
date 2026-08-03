import { Request, Response, NextFunction } from 'express';
import { RunsService } from './runs.service';

/**
 * HTTP handlers for the run-orchestration endpoints: starting a run for an
 * experiment and reading a run's status/results summary. Assumes
 * `req.teamId` is set by upstream auth middleware; `req.user` is set for a
 * logged-in user or a personal API key, and undefined for a team-scoped API key.
 */
export class RunsController {
  constructor(private readonly service: RunsService) {}

  /** POST /api/v1/experiments/:id/runs — start a new run for an experiment. */
  startRun = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id ?? null;
      const result = await this.service.startRun(req.teamId!, userId, req.params.id);
      res.status(202).json({ run_id: result.runId, status: result.status });
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/runs/:id — get a run's status and results summary. */
  getRun = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getRun(req.teamId!, req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /** GET /api/v1/runs/:id/report — get a run's comparison report (matrix, deltas, winner). */
  getReport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getReport(req.teamId!, req.params.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/runs/:id/cells/:cellKey — drill into one grid cell's
   * per-example outputs, judge reasoning, and traces. `req.params.cellKey`
   * arrives already `decodeURIComponent`-ed by Express's router itself (path
   * params are decoded before landing in `req.params`) — this explicit call
   * is kept as a safe no-op so the controller does not silently rely on that
   * framework behavior.
   */
  getCell = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cellKey = decodeURIComponent(req.params.cellKey);
      const result = await this.service.getCell(req.teamId!, req.params.id, cellKey);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
