import { Router } from 'express';
import { datasetsRouter } from './datasets';
import { experimentsRouter } from './experiments';
import { runsRouter } from './runs';
import { optimizeRouter } from './optimize';
import { evalRulesRouter } from './online/online-eval-rule.router';

/**
 * Aggregating router for the evaluations domain (Phase 5). Mounts each
 * sub-domain (datasets, experiments, runs, optimize, eval-rules) under its
 * own path segment. Mounted at `/api/v1` in `app.ts`.
 *
 * `runsRouter` is mounted at `/` (not a dedicated prefix) because it owns two
 * resource roots itself — `POST /experiments/:id/runs` and `GET /runs/:id` —
 * and carries their full paths internally (see `runs.router.ts`). It must be
 * mounted after `experimentsRouter`: Express first tries `experimentsRouter`
 * for any `/experiments/...` request, and since that router has no route
 * matching `POST /:id/runs`, it falls through (calls `next()`) so `runsRouter`
 * gets a chance to match the full original path — the same fallthrough
 * behavior `diffRouter`/`versionsRouter` ordering already relies on in `app.ts`.
 *
 * `optimizeRouter` is mounted at `/prompts` (E6 Task 3): its own route
 * (`POST /:promptId/optimize`) resolves to `/api/v1/prompts/:promptId/optimize`.
 * This does not collide with `aliasesRouter`/`renderRouter`, which `app.ts`
 * mounts separately at the identical `/api/v1/prompts` prefix — those are
 * different router instances matched by Express in turn, and neither of
 * their route patterns (`/:id/aliases...`, `/:name/:alias/render`) overlaps
 * `/:promptId/optimize`.
 */
const r = Router();
r.use('/datasets', datasetsRouter);
r.use('/experiments', experimentsRouter);
r.use('/', runsRouter);
r.use('/prompts', optimizeRouter);
r.use('/eval-rules', evalRulesRouter);

export default r;
