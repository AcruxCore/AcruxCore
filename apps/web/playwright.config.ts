import { defineConfig, devices } from '@playwright/test';

// Shared with vite.config.ts so the suite always targets the port the dev
// server actually binds — `WEB_PORT` from the root .env, or `VITE_PORT` when a
// worktree runs its own server to avoid colliding with another session's.
import { WEB_PORT } from './ports';

/**
 * E2E config. Tests run against the real Vite app (which proxies /api to the
 * Express server on `API_PORT` — see `./ports`) and a real Postgres — no
 * mocks. The API must be running (on that same port) before invoking;
 * Playwright starts/reuses the Vite server.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
