import { createApp } from '../../../app';
import { mountedRoutes, routeKey } from '../../test-utils/routes';

/**
 * Every write route in the evaluation and trace domains carries an explicit role gate.
 *
 * Written after a review of the sweep that gated four evaluation routers found a fifth
 * domain still open, and found the bar set by imitation — the new docstrings said
 * "matching the prompt version-commit route", so the next domain copies whichever
 * neighbour its author happened to read. A checklist does not survive that; a test does.
 *
 * This walks the app's real mounted router tree, so a route added tomorrow is covered
 * the moment it exists. It asserts the ALLOW-LIST, not merely that some middleware is
 * present, which is what makes an inconsistency between two sibling domains visible
 * rather than silently fine.
 *
 * The walk itself lives in `test-utils/routes.ts`, shared with `cross-tenant.test.ts`.
 * The copy that used to sit here could not see through a router mounted at a path
 * parameter, so the whole `/teams/:id/...` surface came out under the wrong path — it
 * changed nothing for the prefixes below, and would have hidden the next domain
 * mounted that way.
 */

/**
 * Routes that are deliberately open to any authenticated member, each with the reason.
 * Adding to this list is a decision; leaving a route out of it is not.
 */
const INTENTIONALLY_UNGATED = new Map<string, string>([
  // A saved view is a shared way of looking at the team's own traffic. Per-user
  // ownership was considered and rejected in `views.service.ts`: "you cannot delete
  // Ali's view" costs a small team more than an accidental deletion does.
  ['POST /api/v1/trace-views', 'shared team furniture — see ViewsService'],
  ['PATCH /api/v1/trace-views/:id', 'shared team furniture — see ViewsService'],
  ['DELETE /api/v1/trace-views/:id', 'shared team furniture — see ViewsService'],
]);

/** The domains this policy covers. Everything writable under them needs a gate. */
const COVERED = [
  '/api/v1/datasets',
  '/api/v1/experiments',
  '/api/v1/runs',
  '/api/v1/optimize',
  '/api/v1/eval-rules',
  '/api/v1/trace-views',
];

describe('route policy', () => {
  const routes = mountedRoutes(createApp());

  it('finds the mounted routes at all — a silent empty walk would pass everything', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(routes.some((r) => r.path.startsWith('/api/v1/datasets'))).toBe(true);
  });

  it('gates every write route in the evaluation and trace-view domains', () => {
    const ungated = routes
      .filter((r) => r.method !== 'GET' && COVERED.some((p) => r.path.startsWith(p)))
      .filter((r) => !r.guards.some((g) => g.startsWith('requireRole') || g.startsWith('requireTeamRole')))
      .map(routeKey)
      .filter((key) => !INTENTIONALLY_UNGATED.has(key));

    expect(ungated).toEqual([]);
  });

  it('records the exact role bar on every evaluation write route', () => {
    // Spelled out rather than summarised per domain, because the thing that goes wrong
    // is one route in a domain drifting from its neighbours. Changing a line here is
    // how a permission change gets made — visibly, and on purpose.
    const actual = Object.fromEntries(
      routes
        .filter((r) => r.method !== 'GET' && COVERED.some((p) => r.path.startsWith(p)))
        .map((r) => [routeKey(r), r.guards.find((g) => g.startsWith('requireRole')) ?? 'ungated']),
    );

    // Writing evaluation data is editing work, so datasets/experiments/runs/optimize sit
    // at editor, matching `POST /runs/:id/promote` and the prompt version-commit route.
    // `eval-rules` splits in two (issue #510): create/update/delete are owner or admin,
    // because a rule judges live traffic continuously and turning one on changes what the
    // team is billed for from then on. `preview` and `to-dataset` are editor, because both
    // are bounded one-off actions on a rule that already exists — smaller than the run an
    // editor may already start. Recorded here so each bar is a decision someone made, not
    // an accident of which neighbour an author copied.
    expect(actual).toEqual({
      'POST /api/v1/trace-views': 'ungated',
      'PATCH /api/v1/trace-views/:id': 'ungated',
      'DELETE /api/v1/trace-views/:id': 'ungated',

      'POST /api/v1/datasets': 'requireRole(owner|admin|editor)',
      'POST /api/v1/datasets/from-feedback': 'requireRole(owner|admin|editor)',
      'PATCH /api/v1/datasets/:id': 'requireRole(owner|admin|editor)',
      'DELETE /api/v1/datasets/:id': 'requireRole(owner|admin|editor)',
      'POST /api/v1/datasets/:id/examples': 'requireRole(owner|admin|editor)',
      'POST /api/v1/datasets/:id/examples/from-feedback': 'requireRole(owner|admin|editor)',
      'PATCH /api/v1/datasets/:id/examples/:exampleId': 'requireRole(owner|admin|editor)',
      'DELETE /api/v1/datasets/:id/examples/:exampleId': 'requireRole(owner|admin|editor)',

      'POST /api/v1/experiments': 'requireRole(owner|admin|editor)',
      'DELETE /api/v1/experiments/:id': 'requireRole(owner|admin|editor)',
      'POST /api/v1/experiments/:id/runs': 'requireRole(owner|admin|editor)',

      'DELETE /api/v1/runs/:id': 'requireRole(owner|admin|editor)',
      'POST /api/v1/runs/:id/promote': 'requireRole(owner|admin|editor)',

      'POST /api/v1/eval-rules': 'requireRole(owner|admin)',
      'PATCH /api/v1/eval-rules/:id': 'requireRole(owner|admin)',
      'DELETE /api/v1/eval-rules/:id': 'requireRole(owner|admin)',
      'POST /api/v1/eval-rules/:id/preview': 'requireRole(owner|admin|editor)',
      'POST /api/v1/eval-rules/:id/to-dataset': 'requireRole(owner|admin|editor)',
    });
  });

  it('gates the optimize route, which is mounted under prompts rather than its own path', () => {
    // `POST /prompts/:promptId/optimize` starts an optimizer completion on top of a full
    // grid, so it belongs to this policy even though its path does not say "optimize"
    // first. A prefix-only sweep misses it, which is precisely why it is asserted here.
    const optimize = routes.find((r) => r.method === 'POST' && r.path.endsWith('/optimize'));
    expect(optimize?.path).toBe('/api/v1/prompts/:promptId/optimize');
    expect(optimize?.guards).toContain('requireRole(owner|admin|editor)');
  });
});
