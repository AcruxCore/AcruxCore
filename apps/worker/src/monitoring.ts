import * as Sentry from '@sentry/node';

/**
 * Initializes Sentry error monitoring for the worker process.
 *
 * Imported right after `./env` in `index.ts`, so `SENTRY_WORKERS_DSN` is
 * already populated. Silently does nothing when it's unset, so local dev
 * needs no Sentry project to boot the worker.
 *
 * Reporting is also limited to `NODE_ENV=production`, for the same reason as
 * the API's `instrument.ts`: one shared `.env` means a local worker holding
 * the real DSN would file laptop errors as production issues, and the feed
 * gives no way to tell which is which.
 *
 * The default `OnUncaughtException`/`OnUnhandledRejection` integrations are
 * dropped: `index.ts` already registers its own `process.on('uncaughtException'
 * | 'unhandledRejection')` handlers with deliberate exit behaviour (see that
 * file's comments on the boot-race incident), and those handlers call
 * `Sentry.captureException` themselves. Leaving Sentry's defaults enabled
 * would report the same error twice and race its own `process.exit` against
 * the handlers already in `index.ts`.
 */
if (process.env.SENTRY_WORKERS_DSN && process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.SENTRY_WORKERS_DSN,
    environment: 'production',
    tracesSampleRate: 0.1,
    integrations: (integrations) =>
      integrations.filter(
        (integration) =>
          integration.name !== 'OnUncaughtException' && integration.name !== 'OnUnhandledRejection',
      ),
  });
} else if (process.env.SENTRY_WORKERS_DSN) {
  console.log(`[monitoring] Sentry disabled — NODE_ENV is '${process.env.NODE_ENV ?? 'unset'}', not 'production'.`);
}

export { Sentry };
