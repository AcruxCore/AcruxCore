import express from 'express';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { Sentry } from './src/shared/monitoring';
import { AUTH_BASE_PATH, getAuth } from './src/shared/auth';
import { authRouter } from './src/auth';
import { apiKeysRouter } from './src/api-keys';
import { promptsRouter } from './src/prompts';
import { toolsRouter } from './src/tools';
import { toolAnalyticsRouter } from './src/tools/analytics';
import { toolVersionsRouter } from './src/tools/versions';
import { toolAliasesRouter } from './src/tools/aliases';
import { toolExecuteRouter } from './src/tools/execute';
import { toolSyncRouter } from './src/tools/sync';
import { toolResolveRouter } from './src/tools/resolve';
import { secretsRouter } from './src/secrets';
import { versionsRouter } from './src/prompts/versions';
import { aliasesRouter, renderRouter } from './src/prompts/aliases';
import { toolBindingsRouter } from './src/prompts/tool-bindings';
import { diffRouter } from './src/prompts/diff';
import { exportRouter } from './src/prompts/export';
import { importRouter } from './src/prompts/import';
import { healthRouter } from './src/health';
import { auditRouter } from './src/audit';
import { teamsRouter, inviteAcceptRouter } from './src/teams';
import { connectionsRouter } from './src/gateway/connections';
import { modelsRouter } from './src/gateway/models';
import { gatewayCompletionsRouter } from './src/gateway/completions';
import { virtualKeysRouter } from './src/gateway/keys';
import { budgetsRouter } from './src/gateway/budgets';
import { cacheRouter } from './src/gateway/cache';
import { usageRouter } from './src/gateway/usage';
import { tracesRouter } from './src/traces';
import { ingestRouter } from './src/traces/ingest';
import { otlpRouter } from './src/traces/ingest/otlp';
import { sessionsRouter } from './src/traces/sessions';
import { traceQueryRouter, promptTracesRouter } from './src/traces/query';
import { feedbackRouter } from './src/traces/feedback';
import evaluationsRouter from './src/evaluations/evaluations.router';
import { notificationsRouter } from './src/notifications';
import { unsubscribeRouter } from './src/email/unsubscribe';
import { errorMiddleware } from './src/shared/middleware';

/**
 * Creates and configures the Express application.
 * Does NOT call `listen()` — that lives in server.ts so tests can import the
 * app without binding to a port.
 *
 * @returns Configured Express app instance.
 */
export function createApp(): express.Application {
  const app = express();

  // ── Security headers (Finding #18) ────────────────────────────────────────
  // "prod sits behind nginx" is no longer sufficient rationale for skipping this:
  // self-hosting is an explicit, supported deployment model, and not every
  // self-hoster fronts the API with a hardened reverse proxy. helmet() also
  // covers app.disable('x-powered-by') on its own. Default config: this is a
  // pure JSON API with no HTML/static assets served from this app, so
  // helmet's default CSP and cross-origin policies have nothing to conflict with.
  app.use(helmet());

  // ── Authentication ────────────────────────────────────────────────────────
  // Browsers authenticate with an httpOnly session cookie validated against
  // `auth_sessions`; SDKs send an `Authorization: Bearer acx_sk_…` API key. No
  // CORS is configured on purpose — production serves web and API from one
  // origin behind nginx, and dev goes through Vite's `/api` proxy, so a cookie
  // is never a cross-site request. Adding CORS with credentials would widen
  // that for no gain.
  //
  // ORDER IS LOAD-BEARING across the next four statements.
  //
  // 1. Our own auth routes (`me`, `teams`, `switch-team`) must be registered
  //    before Better Auth's catch-all, which answers everything else under
  //    `/api/v1/auth`. None of the three names collide with Better Auth's.
  app.use('/api/v1', authRouter);

  // 2. Better Auth's handler, mounted BEFORE `express.json()`. It reads the raw
  //    request stream itself, so a body already consumed by a JSON parser
  //    arrives empty and every sign-in silently fails validation.
  app.all(`${AUTH_BASE_PATH}/*`, toNodeHandler(getAuth()));

  // 3. OTLP trace receiver: POST /api/v1/traces/otlp. Mounted BEFORE
  //    `express.json()` because it brings its own content-type-scoped parsers
  //    with a 10MB limit — an OTel exporter's JSON batch routinely exceeds the
  //    100KB default below, and being 413'd there is invisible to the endpoint.
  app.use('/api/v1', otlpRouter);

  // 4. Body parsing for every other route.
  app.use(express.json());

  // ── Routers ───────────────────────────────────────────────────────────────
  // Health: GET /api/v1/health — unauthenticated on purpose, for load
  // balancers, Docker HEALTHCHECK and uptime monitors, none of which carry an
  // API key.
  app.use('/api/v1', healthRouter);
  app.use('/api/v1', apiKeysRouter);
  // Import must be mounted BEFORE prompts/:id routes so "import" isn't matched as an ID
  app.use('/api/v1', importRouter);
  app.use('/api/v1', promptsRouter);
  // Tool analytics (TC7): GET /api/v1/tools/analytics — MUST be mounted BEFORE
  // toolsRouter, which registers GET /tools/:id, or "analytics" gets matched as :id.
  app.use('/api/v1', toolAnalyticsRouter);
  // Tool sync: POST /api/v1/tools/sync — create-or-commit-or-nothing from code.
  // MUST be mounted BEFORE toolsRouter for the same reason as toolAnalyticsRouter.
  app.use('/api/v1', toolSyncRouter);
  // Tool resolve: POST /api/v1/tools/resolve — batch name→schema+executorType.
  // Also mounted BEFORE toolsRouter, so "resolve" is never matched as a :id.
  app.use('/api/v1', toolResolveRouter);
  // Tools: Tool shell CRUD — /api/v1/tools[/:id] (TC1)
  app.use('/api/v1', toolsRouter);
  // Tool versions: POST/GET /api/v1/tools/:id/versions[/:version_number] (TC1)
  app.use('/api/v1', toolVersionsRouter);
  // Tool aliases: GET /api/v1/tools/:id/aliases, POST /api/v1/tools/:id/aliases/:alias/promote (TC1)
  app.use('/api/v1/tools', toolAliasesRouter);
  // Tool execute: POST /api/v1/tools/:id/execute — server-side http executor run (TC4)
  app.use('/api/v1', toolExecuteRouter);
  // Secrets (TC4): team-scoped credential store — POST/GET /api/v1/secrets, PUT/DELETE /api/v1/secrets/:id
  app.use('/api/v1/secrets', secretsRouter);
  // Diff must be mounted BEFORE versionsRouter so /versions/diff is not swallowed by /versions/:version_number
  app.use('/api/v1', diffRouter);
  // Versions: POST/GET /api/v1/prompts/:id/versions[/:version_number]
  app.use('/api/v1', versionsRouter);
  // Export: GET /api/v1/prompts/:id/versions/:version_number/export
  app.use('/api/v1', exportRouter);
  // Aliases: GET /api/v1/prompts/:id/aliases, POST /api/v1/prompts/:id/aliases/:alias/promote
  app.use('/api/v1/prompts', aliasesRouter);
  app.use('/api/v1/prompts', toolBindingsRouter);
  // Render: POST /api/v1/prompts/:name/:alias/render
  app.use('/api/v1/prompts', renderRouter);
  // Audit: GET /api/v1/prompts/:id/audit
  app.use('/api/v1', auditRouter);
  // Notification preferences (spec B): GET/PATCH /api/v1/notifications/preferences
  app.use('/api/v1/notifications', notificationsRouter);
  // One-click unsubscribe (spec C): GET/POST /api/v1/email/unsubscribe.
  // Deliberately UNAUTHENTICATED — RFC 8058 clients POST with no session, and a
  // login prompt would defeat the point. The signed token is the credential.
  app.use('/api/v1/email', unsubscribeRouter);
  // Teams: /api/v1/teams/:id/members, /api/v1/teams/:id/invites, /api/v1/teams/:id/api-keys
  app.use('/api/v1/teams', teamsRouter);
  // Invite accept: POST /api/v1/teams/invites/:token/accept (no team ID prefix — user doesn't know it yet)
  app.use('/api/v1', inviteAcceptRouter);
  // Gateway — provider connections (BYOK): /api/v1/gateway/connections
  app.use('/api/v1/gateway/connections', connectionsRouter);
  // Gateway — model registry: /api/v1/gateway/models
  app.use('/api/v1/gateway/models', modelsRouter);
  // Gateway completions: POST /api/v1/gateway/chat/completions
  app.use('/api/v1/gateway', gatewayCompletionsRouter);
  // Gateway virtual keys: /api/v1/gateway/keys
  app.use('/api/v1/gateway', virtualKeysRouter);
  // Gateway budgets: /api/v1/gateway/budgets
  app.use('/api/v1/gateway/budgets', budgetsRouter);
  // Gateway response cache: DELETE /api/v1/gateway/cache
  app.use('/api/v1/gateway', cacheRouter);
  // Gateway usage analytics: GET /api/v1/gateway/usage, /requests, /requests/:id
  app.use('/api/v1/gateway', usageRouter);
  // Traces (Phase 3): GET/PUT /api/v1/traces/settings (T1), GET /api/v1/traces/analytics (T5).
  // Static /traces/* routers only — must precede traceQueryRouter's /traces/:id below.
  app.use('/api/v1/traces', tracesRouter);
  // Traces — ingestion: POST /api/v1/traces
  app.use('/api/v1', ingestRouter);
  // Traces — OTLP receiver (POST /api/v1/traces/otlp) is mounted further up,
  // ahead of `express.json()`; see the body-parsing note there.
  // Traces — sessions (Phase 3 T3): GET /api/v1/sessions, /sessions/:id
  app.use('/api/v1/sessions', sessionsRouter);
  // Traces — user feedback (T6): /api/v1/traces/:id/feedback, /traces/feedback/summary.
  // MUST be mounted BEFORE the T4 traces query router so /traces/feedback/summary
  // is not swallowed by /traces/:id. (Deviates from conventions §5's single
  // aggregating tracesRouter: T6 mounts a sibling router ahead of it.)
  app.use('/api/v1', feedbackRouter);
  // Trace query/search: GET /api/v1/traces, GET /api/v1/traces/:id
  // NOTE: must be mounted AFTER any static /traces/* routers (T1 /traces/settings,
  // T5 /traces/analytics) so /traces/:id does not shadow them. Phase 3 conventions
  // §5 envisions a single aggregating tracesRouter; direct mounting here matches
  // the existing per-domain gateway precedent.
  app.use('/api/v1', traceQueryRouter);
  // Reverse prompt-version lineage: GET /api/v1/prompts/:id/versions/:n/traces
  app.use('/api/v1', promptTracesRouter);
  // Evaluations (Phase 5 E2): datasets — /api/v1/datasets, /api/v1/datasets/from-feedback
  app.use('/api/v1', evaluationsRouter);

  // Reports unhandled 5xx errors to Sentry, then forwards to our own handler
  // below (via `next(err)`) unchanged — the response shape doesn't change.
  // A no-op if `SENTRY_API_DSN` was unset when the process booted.
  Sentry.setupExpressErrorHandler(app);

  // ── Global error handler (must be last) ───────────────────────────────────
  app.use(errorMiddleware);

  return app;
}
