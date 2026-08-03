import { Request, Response, NextFunction } from 'express';
import { OptimizeService } from './optimize.service';
import { StartOptimizeSchema, PromoteCandidateSchema } from './optimize.types';
import { ValidationError } from '../../shared/errors';

/**
 * HTTP handler for the optimize-loop kickoff endpoint. Assumes `req.teamId`
 * is set by upstream auth middleware; `req.user` is set for a logged-in user
 * or a personal API key, and undefined for a team-scoped API key.
 */
export class OptimizeController {
  constructor(private readonly service: OptimizeService) {}

  /**
   * POST /api/v1/prompts/:promptId/optimize — draft candidate rewrites for a
   * prompt's production version against a dataset, then run them (+ the
   * production baseline) through the grid. Returns 202 immediately; the
   * actual drafting/grid-run happens out of the request path (`processOptimize`).
   */
  start = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = StartOptimizeSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const userId = req.user?.id ?? null;
      const result = await this.service.startOptimize(req.teamId!, userId, req.params.promptId, parsed.data);
      res.status(202).json({ run_id: result.runId, status: result.status });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/v1/runs/:id/promote — promote one optimizer-drafted candidate
   * to a real prompt version and move an alias to it (E6 Task 5). Mounted
   * behind the same `requireRole('owner', 'admin', 'editor')` guard used by
   * the prompt-alias promote route (`aliases.router.ts`) and the
   * version-commit route (`versions.router.ts`) — enforced by the router,
   * not here, so by the time this handler runs `req.user` is guaranteed to
   * be a role-holding session (team-scoped API keys are rejected upstream by
   * that same guard).
   */
  promote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = PromoteCandidateSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

      const result = await this.service.promoteCandidate(req.teamId!, req.user!.id, req.params.id, parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/v1/runs/:id/candidates/:candidateId — read one optimizer-drafted
   * candidate's template + rationale, so a promote-review UI can show what is
   * about to be promoted (E7 Task 5). Read-only: mounted behind
   * `requireAnyAuth` only, no role restriction — viewing a candidate does
   * not require promote-right, only actually promoting it does.
   */
  getCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.service.getCandidate(req.teamId!, req.params.id, req.params.candidateId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}
