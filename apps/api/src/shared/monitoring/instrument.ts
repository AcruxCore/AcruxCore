import * as Sentry from '@sentry/node';

/**
 * Initializes Sentry error monitoring for the API process.
 *
 * Imported as the very first thing in `server.ts` — before `./app` — so
 * Sentry's Node instrumentation is installed before Express (and anything
 * Express pulls in) is required. Silently does nothing when
 * `SENTRY_API_DSN` is unset, so local dev and CI need no Sentry project to
 * boot the API.
 *
 * Reporting is also limited to `NODE_ENV=production`. The repo shares one
 * `.env` across local dev, tests and the deployed stack, so a developer who
 * copies the real DSN in gets their laptop's errors filed next to the
 * server's — indistinguishable in the issue feed, and every local
 * experiment becomes a production-looking alert. Only the deployed stack
 * (which sets `NODE_ENV=production`) reports.
 */
if (process.env.SENTRY_API_DSN && process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.SENTRY_API_DSN,
    environment: 'production',
    // Errors are always captured; this only samples performance traces, so it
    // stays low to bound ingest volume/cost.
    tracesSampleRate: 0.1,
  });
} else if (process.env.SENTRY_API_DSN) {
  console.log(`[monitoring] Sentry disabled — NODE_ENV is '${process.env.NODE_ENV ?? 'unset'}', not 'production'.`);
}

export { Sentry };
