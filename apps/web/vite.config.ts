/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { WEB_PORT, API_PROXY_TARGET } from './ports';

/**
 * Vite config for the web app.
 *
 * Auth is an httpOnly session cookie set by our own API — no token in browser
 * storage and no `Authorization` header. The API configures no CORS, so in dev
 * all `/api` requests are proxied to the Express server (`API_PORT`, :3001) and
 * reach it same-origin. That is what makes the cookie work at all: a
 * cross-origin call to the API port would be a third-party cookie the browser
 * withholds, so the proxy is load-bearing here, not a convenience.
 *
 * Both ports come from the repo's single root `.env` via `./ports` — see there
 * for the resolution order.
 *
 * `test` (Vitest) reuses this file's `resolve.alias` and plugins rather than a
 * separate `vitest.config.ts`, which would not inherit the `@` alias. Only pure
 * functions are unit-tested here — no jsdom/RTL — so the environment is `node`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: WEB_PORT,
    // Fail loudly instead of silently drifting to the next free port. A dev
    // server that quietly moved to :5174 while the e2e suite, the proxy and
    // every bookmark still pointed at the configured port cost real debugging
    // time — an EADDRINUSE naming the port is the cheaper failure.
    strictPort: true,
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
  define: {
    // Maps the repo's canonical `SENTRY_WEB_DSN` onto the `VITE_`-prefixed
    // name the client bundle reads, so the same variable name works in local
    // dev (ambient shell env, see .envrc) and in the Docker build (passed as
    // a build ARG — see apps/web/Dockerfile). A statically-replaced literal,
    // not a runtime read, so it must stay a `define`, not a `.env` file.
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(process.env.SENTRY_WEB_DSN ?? ''),
    // Same pattern for the GA4 measurement ID (see src/lib/analytics.ts) —
    // unset locally so `npm run dev` never reports traffic.
    'import.meta.env.VITE_GA4_MEASUREMENT_ID': JSON.stringify(process.env.GA4_MEASUREMENT_ID ?? ''),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Task 1 ships the runner only — the first *.test.ts files land in later tasks.
    passWithNoTests: true,
  },
});
